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
import type { ScreenCapture } from "../capture/index.js";
import type { InputController } from "../input/index.js";
import { runAutotype, type TypingBackend } from "../autotyper/index.js";
import type { InputLockManager } from "../inputlock/index.js";

export interface ServerDeps {
  secret: string;
  nickname: string;
  port: number;
  /** Interface to bind to; default binds all interfaces. */
  host?: string;
  tls: { cert: string; key: string };
  input: InputController;
  capture: ScreenCapture;
  typingBackend: TypingBackend;
  inputLock: InputLockManager;
}

const SCREENSHOT_INTERVAL = 2000;

/** Minimal HTML escaping for the nickname shown on the cert-acceptance page. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

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
    // A minimal request handler is essential: browsers refuse a wss:// connection
    // to an untrusted self-signed cert until the user has accepted it, and the
    // only way to accept it is to load https://<agent>:<port> in a tab. Without
    // a handler that request hangs with no response, so the cert never gets
    // trusted and the client can never connect. This page also serves as a
    // reachability check ("if you see this, the client can reach the agent").
    this.https = createServer(
      { cert: this.deps.tls.cert, key: this.deps.tls.key },
      (_req, res) => {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(
          `<!doctype html><meta charset="utf-8">` +
            `<title>Back Connector agent</title>` +
            `<body style="font-family:system-ui;max-width:32rem;margin:3rem auto;line-height:1.5">` +
            `<h1>✅ Agent reachable</h1>` +
            `<p>You've reached the <strong>${escapeHtml(this.deps.nickname)}</strong> agent and accepted its certificate.</p>` +
            `<p>You can close this tab and press <strong>Connect</strong> in the client.</p>` +
            `</body>`,
        );
      },
    );
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
    await this.deps.inputLock.unlock();
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
        // Safety: never leave the agent's input locked with no controller.
        void this.deps.inputLock.unlock();
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

    // Tell the client whether input-lock is available and its current state.
    this.send(ws, {
      type: "inputLockState",
      locked: this.deps.inputLock.isLocked,
      supported: this.deps.inputLock.supported,
    });

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
          this.deps.inputLock.noteClientActivity();
          await this.deps.input.applyMouse(msg);
          break;
        case "key":
          this.deps.inputLock.noteClientActivity();
          await this.deps.input.applyKey(msg);
          break;
        case "autotype":
          this.deps.inputLock.noteClientActivity();
          await this.handleAutotype(ws, msg.text, msg.profile);
          break;
        case "setInputLock":
          await this.handleSetInputLock(ws, msg.locked);
          break;
        case "auth":
          break; // already authenticated; ignore duplicate
      }
    } catch (err) {
      this.send(ws, { type: "agentError", message: String(err) });
    }
  }

  private async handleSetInputLock(ws: WebSocket, locked: boolean): Promise<void> {
    if (locked && !this.deps.inputLock.supported) {
      this.send(ws, {
        type: "agentError",
        message: "local input lock is not supported on this agent's OS yet",
      });
      this.send(ws, { type: "inputLockState", locked: false, supported: false });
      return;
    }
    if (locked) await this.deps.inputLock.lock();
    else await this.deps.inputLock.unlock();
    // State is also broadcast via notifyLockState (manager onChange), but reply
    // here too so a no-op request still gets an authoritative answer.
    this.send(ws, {
      type: "inputLockState",
      locked: this.deps.inputLock.isLocked,
      supported: this.deps.inputLock.supported,
    });
  }

  /** Push the current lock state to the connected controller, if any. */
  notifyLockState(locked: boolean): void {
    if (this.controller) {
      this.send(this.controller, {
        type: "inputLockState",
        locked,
        supported: this.deps.inputLock.supported,
      });
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
