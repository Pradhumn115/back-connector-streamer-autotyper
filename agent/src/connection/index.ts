import { createServer, type Server as HttpsServer } from "node:https";
import { timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import {
  encodeFrame,
  encodeMessage,
  parseClientMessage,
  type AgentMessage,
  type AutotypeProfile,
} from "@bcsa/shared";
import type { CaptureLoop } from "../capture/index.js";
import type { InputController } from "../input/index.js";
import { runAutotype, type TypingBackend } from "../autotyper/index.js";

export interface ServerDeps {
  secret: string;
  nickname: string;
  port: number;
  /** Interface to bind to; default binds all interfaces. */
  host?: string;
  tls: { cert: string; key: string };
  input: InputController;
  capture: CaptureLoop;
  typingBackend: TypingBackend;
}

const SCREENSHOT_INTERVAL = 2000;

/** Constant-time secret comparison to avoid leaking length/content via timing. */
function secretsMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * The agent's WSS server. Accepts a single authenticated controller at a time,
 * streams screen frames to it, and applies its mouse/keyboard/autotype commands.
 */
export class ConnectionServer {
  private https: HttpsServer | null = null;
  private wss: WebSocketServer | null = null;
  private controller: WebSocket | null = null;
  private seq = 0;
  private autotyping = false;

  constructor(private readonly deps: ServerDeps) {}

  listen(): Promise<void> {
    this.https = createServer({ cert: this.deps.tls.cert, key: this.deps.tls.key });
    this.wss = new WebSocketServer({ server: this.https });
    this.wss.on("connection", (ws) => this.onConnection(ws));

    return new Promise((resolve) => {
      this.https!.listen(this.deps.port, this.deps.host, () => resolve());
    });
  }

  /** The actual bound port (useful when constructed with port 0 in tests). */
  boundPort(): number {
    const addr = this.https?.address() as AddressInfo | null;
    return addr ? addr.port : this.deps.port;
  }

  async close(): Promise<void> {
    this.deps.capture.stop();
    this.controller?.close();
    await new Promise<void>((resolve) => {
      if (!this.wss) return resolve();
      this.wss.close(() => resolve());
    });
    await new Promise<void>((resolve) => {
      if (!this.https) return resolve();
      this.https.close(() => resolve());
    });
  }

  private send(ws: WebSocket, msg: AgentMessage): void {
    if (ws.readyState === ws.OPEN) ws.send(encodeMessage(msg));
  }

  private onConnection(ws: WebSocket): void {
    // Only one controller at a time.
    if (this.controller) {
      this.send(ws, { type: "authResult", ok: false, reason: "busy" });
      ws.close();
      return;
    }

    let authed = false;

    ws.on("message", (data, isBinary) => {
      if (isBinary) return; // client never sends binary frames
      let msg;
      try {
        msg = parseClientMessage(data.toString());
      } catch {
        this.send(ws, { type: "agentError", message: "malformed message" });
        return;
      }

      if (!authed) {
        if (msg.type !== "auth") {
          this.send(ws, { type: "authResult", ok: false, reason: "auth required" });
          ws.close();
          return;
        }
        if (!secretsMatch(msg.secret, this.deps.secret)) {
          this.send(ws, { type: "authResult", ok: false, reason: "invalid secret" });
          ws.close();
          return;
        }
        authed = true;
        this.controller = ws;
        void this.onAuthenticated(ws);
        return;
      }

      void this.onControlMessage(ws, msg);
    });

    ws.on("close", () => {
      if (this.controller === ws) {
        this.controller = null;
        this.autotyping = false;
        this.deps.capture.stop();
      }
    });

    ws.on("error", () => {
      /* handled by close */
    });
  }

  private async onAuthenticated(ws: WebSocket): Promise<void> {
    this.send(ws, { type: "authResult", ok: true });
    try {
      const { width, height } = await this.deps.input.screenSize();
      this.send(ws, {
        type: "agentInfo",
        screenWidth: width,
        screenHeight: height,
        nickname: this.deps.nickname,
      });
    } catch (err) {
      this.send(ws, { type: "agentError", message: `screen size: ${String(err)}` });
    }

    this.deps.capture.setInterval(SCREENSHOT_INTERVAL);
    this.deps.capture.start((image) => {
      if (this.controller?.readyState === this.controller?.OPEN) {
        const buf = encodeFrame(this.seq++, Date.now(), image.format, image.data);
        this.controller!.send(buf, { binary: true });
      }
    });
  }

  private async onControlMessage(
    ws: WebSocket,
    msg: ReturnType<typeof parseClientMessage>,
  ): Promise<void> {
    try {
      switch (msg.type) {
        case "setMode":
          this.deps.capture.setInterval(msg.intervalMs);
          break;
        case "mouse":
          await this.deps.input.applyMouse(msg);
          break;
        case "key":
          await this.deps.input.applyKey(msg);
          break;
        case "autotype":
          await this.handleAutotype(ws, msg.text, msg.profile);
          break;
        case "auth":
          break; // already authenticated; ignore duplicate
      }
    } catch (err) {
      this.send(ws, { type: "agentError", message: String(err) });
    }
  }

  private async handleAutotype(
    ws: WebSocket,
    text: string,
    profile: AutotypeProfile,
  ): Promise<void> {
    if (this.autotyping) {
      this.send(ws, { type: "agentError", message: "autotype already running" });
      return;
    }
    this.autotyping = true;
    try {
      await runAutotype(
        text,
        profile,
        { backend: this.deps.typingBackend },
        { onProgress: (done, total) => this.send(ws, { type: "autotypeProgress", done, total }) },
      );
      this.send(ws, { type: "autotypeDone" });
    } finally {
      this.autotyping = false;
    }
  }
}
