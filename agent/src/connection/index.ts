import { createServer, type Server as HttpsServer } from "node:https";
import { timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import {
  AudioFormat,
  encodeAudioFrame,
  encodeFrame,
  encodeMessage,
  parseClientMessage,
  type AgentMessage,
  type AutotypeProfile,
} from "@bcsa/shared";
import type { ScreenCapture } from "../capture/index.js";
import type { AudioCapture } from "../audio/index.js";
import type { InputController } from "../input/index.js";
import { runAutotype, type TypingBackend } from "../autotyper/index.js";
import type { InputLockManager } from "../inputlock/index.js";
import { runDiagnostics } from "../diagnostics/index.js";
import { WebrtcSession } from "../webrtc/session.js";
import type { VideoCodecTier } from "../webrtc/codecs.js";

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
  audio: AudioCapture;
  /** Detected display refresh rate (Hz), reported to the client for fps target. */
  refreshHz: number;
  /** ffmpeg args (input + RTP output) for the WebRTC video/audio relays. */
  webrtcFfmpegArgs: {
    /** Video args depend on which codec tier negotiation picked (see webrtc/codecs.ts). */
    video: (tier: VideoCodecTier, port: number) => string[];
    audio: (port: number) => string[];
  };
  /**
   * Overrides the Classic backpressure threshold (see MAX_QUEUED_FRAME_BYTES).
   * Test-only escape hatch: a loopback socket drains far too fast to build a
   * real backlog on demand, so the drop path can only be exercised by moving
   * the threshold. Omit in real usage.
   */
  maxQueuedFrameBytes?: number;
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
 * How many bytes may sit unsent in the controller socket before Classic frames
 * start being dropped instead of queued.
 *
 * Classic is MJPEG: every frame is a full intra frame, ~90-270KB at the sizes
 * this agent captures (measured: 267KB at 1920 wide, q:v 6). At the 120fps the
 * client requests on a 120Hz display that is ~206 Mbit/s, which no WiFi or
 * Tailscale link carries. Without a ceiling, ws simply queues the surplus in
 * memory: the backlog grew by roughly the difference every second, so the
 * picture fell steadily further behind real time and never recovered. That is
 * the "Classic starts lagging after 10-15s" symptom -- not dropped frames, and
 * not a scaling bug, but unbounded queueing.
 *
 * Two frames' worth. Big enough that ordinary jitter doesn't cause drops, small
 * enough that the displayed frame is never more than a frame or two old. This
 * is the same drop-stale policy the client already applies on receive (see
 * useConnection's handleFrame): for a live screen, a queued frame is worthless
 * the instant a newer one exists, so dropping is strictly correct rather than a
 * compromise.
 *
 * The WebRTC path needs no equivalent -- congestion control is part of the
 * transport there.
 */
const MAX_QUEUED_FRAME_BYTES = 512 * 1024;

/** Minimum gap between "dropping frames" log lines. */
const DROP_LOG_THROTTLE_MS = 5000;

/**
 * The agent's WSS server. Accepts a single authenticated controller at a time,
 * streams screen frames to it, and applies its mouse/keyboard/autotype commands.
 */
export class ConnectionServer {
  private https: HttpsServer | null = null;
  private wss: WebSocketServer | null = null;
  private controller: WebSocket | null = null;
  private seq = 0;
  private audioSeq = 0;
  private autotyping = false;
  private autotypeAbort: AbortController | null = null;
  private webrtc: WebrtcSession | null = null;
  /** Frames dropped for backpressure since the last log line. */
  private droppedFrames = 0;
  private lastDropLogAt = 0;

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
    this.deps.audio.stop();
    this.webrtc?.close();
    this.webrtc = null;
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

  /**
   * Reports sustained frame dropping, throttled.
   *
   * Dropping is the correct response to a saturated link, but silence about it
   * would be misleading: a user seeing a low frame rate deserves to know the
   * link is the limit rather than the capture. Throttled because under real
   * saturation this fires on nearly every captured frame.
   */
  private logDroppedFrames(bufferedAmount: number): void {
    const now = Date.now();
    if (now - this.lastDropLogAt < DROP_LOG_THROTTLE_MS) return;
    const dropped = this.droppedFrames;
    this.droppedFrames = 0;
    this.lastDropLogAt = now;
    process.stderr.write(
      `[capture] link saturated — dropped ${dropped} frame(s), ` +
        `${(bufferedAmount / 1024).toFixed(0)}KB still queued. ` +
        `Lower the frame rate or resolution, or use WebRTC, for a smoother stream.\n`,
    );
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
        this.autotypeAbort?.abort(); // stop any in-progress autotype
        this.deps.capture.stop();
        this.deps.audio.stop();
        this.webrtc?.close();
        this.webrtc = null;
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
        refreshHz: this.deps.refreshHz,
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

    // Tell the client whether system-audio capture is available. Off by default;
    // the client turns it on when it wants to transcribe.
    this.send(ws, {
      type: "audioState",
      enabled: false,
      supported: this.deps.audio.supported,
    });

    this.deps.capture.setInterval(SCREENSHOT_INTERVAL);
    this.startCapture();
  }

  /**
   * (Re)starts the Classic frame-capture loop with the standard forwarding
   * callback. Used both on initial connect and to resume Classic capture
   * after a WebRTC session stops it — `capture.start()` is idempotent-safe
   * to call again (it just respawns ffmpeg), so this is also safe to call
   * when capture is already running.
   */
  private startCapture(): void {
    this.deps.capture.start((image) => {
      const ws = this.controller;
      if (ws?.readyState !== ws?.OPEN || !ws) return;

      // Drop rather than queue once the socket is already behind. Encoding is
      // skipped too, not just the send: a frame that would only be dropped is
      // not worth the JPEG encode. See MAX_QUEUED_FRAME_BYTES for why an
      // unbounded queue here made Classic drift permanently behind real time.
      if (ws.bufferedAmount > (this.deps.maxQueuedFrameBytes ?? MAX_QUEUED_FRAME_BYTES)) {
        this.droppedFrames++;
        this.logDroppedFrames(ws.bufferedAmount);
        return;
      }

      const buf = encodeFrame(this.seq++, Date.now(), image.format, image.data);
      ws.send(buf, { binary: true });
    });
  }

  private async onControlMessage(
    ws: WebSocket,
    msg: ReturnType<typeof parseClientMessage>,
  ): Promise<void> {
    try {
      switch (msg.type) {
        case "setMode":
          if (this.webrtc) {
            this.send(ws, {
              type: "agentError",
              message: "Classic video is paused while WebRTC is active",
            });
            break;
          }
          // Switching back from WebRTC leaves capture stopped (handleStartWebrtc
          // called capture.stop()); setInterval() alone only restarts ffmpeg
          // when capture is already running (see FfmpegCapture.setInterval),
          // so it silently no-ops here otherwise, leaving Classic mode dead
          // until a full reconnect. Explicitly restart it.
          this.startCapture();
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
        case "cancelAutotype":
          this.autotypeAbort?.abort();
          break;
        case "setInputLock":
          await this.handleSetInputLock(ws, msg.locked);
          break;
        case "setAudio":
          this.handleSetAudio(ws, msg.enabled);
          break;
        case "runDiagnostics":
          await this.handleRunDiagnostics(ws);
          break;
        case "startWebrtc":
          await this.handleStartWebrtc(ws);
          break;
        case "stopWebrtc":
          this.handleStopWebrtc(ws);
          break;
        case "webrtcAnswer":
          await this.handleWebrtcAnswer(ws, msg.sdp);
          break;
        case "auth":
          break; // already authenticated; ignore duplicate
      }
    } catch (err) {
      this.send(ws, { type: "agentError", message: String(err) });
    }
  }

  private async handleRunDiagnostics(ws: WebSocket): Promise<void> {
    let screenSize: { width: number; height: number } | null = null;
    try {
      screenSize = await this.deps.input.screenSize();
    } catch {
      screenSize = null; // reported as a failed check
    }
    const checks = runDiagnostics({
      refreshHz: this.deps.refreshHz,
      inputLockSupported: this.deps.inputLock.supported,
      audioSupported: this.deps.audio.supported,
      screenSize,
    });
    this.send(ws, { type: "diagnostics", checks });
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
    try {
      if (locked) await this.deps.inputLock.lock();
      else await this.deps.inputLock.unlock();
    } catch (err) {
      // Engaging the lock failed (e.g. Windows BlockInput refused because the
      // agent isn't elevated). Report the reason AND the true state, so the
      // client never shows a lock that isn't actually holding.
      this.send(ws, { type: "agentError", message: String(err) });
      this.send(ws, {
        type: "inputLockState",
        locked: this.deps.inputLock.isLocked,
        supported: this.deps.inputLock.supported,
      });
      return;
    }
    // State is also broadcast via notifyLockState (manager onChange), but reply
    // here too so a no-op request still gets an authoritative answer.
    this.send(ws, {
      type: "inputLockState",
      locked: this.deps.inputLock.isLocked,
      supported: this.deps.inputLock.supported,
    });
  }

  /**
   * Start or stop streaming system-audio (loopback) frames to the controller.
   * If capture isn't supported, reports that honestly instead of a silent no-op.
   */
  private handleSetAudio(ws: WebSocket, enabled: boolean): void {
    if (this.webrtc) {
      this.send(ws, {
        type: "agentError",
        message: "Classic audio is paused while WebRTC is active",
      });
      return;
    }
    if (enabled && !this.deps.audio.supported) {
      this.send(ws, {
        type: "agentError",
        message:
          "system-audio capture unavailable: no loopback device (install BlackHole/VB-Cable, see README)",
      });
      this.send(ws, { type: "audioState", enabled: false, supported: false });
      return;
    }
    if (enabled) {
      this.audioSeq = 0;
      this.deps.audio.start((pcm) => {
        if (this.controller?.readyState === this.controller?.OPEN) {
          const buf = encodeAudioFrame(
            this.audioSeq++,
            Date.now(),
            this.deps.audio.sampleRate,
            this.deps.audio.channels,
            AudioFormat.PCM_S16LE,
            pcm,
          );
          this.controller!.send(buf, { binary: true });
        }
      });
    } else {
      this.deps.audio.stop();
    }
    this.send(ws, {
      type: "audioState",
      enabled,
      supported: this.deps.audio.supported,
    });
  }

  /**
   * Start a WebRTC session: stop the Classic capture/audio pipelines (mode
   * exclusivity — exactly one media pipeline runs at a time), create the
   * offer, and send it to the client. Idempotent if already active.
   */
  private async handleStartWebrtc(ws: WebSocket): Promise<void> {
    if (this.webrtc) {
      // Already active; idempotent, but still answer so a client that double-
      // sent startWebrtc (e.g. a retry) doesn't wait forever for a response.
      this.send(ws, { type: "webrtcState", active: true });
      return;
    }
    // Same "unsupported" honesty as handleSetAudio's Classic-mode path: don't
    // silently substitute the anullsrc fallback without telling the client.
    // The session still starts (silence beats failing the whole session), but
    // the client learns the audio track carries no real signal.
    if (!this.deps.audio.supported) {
      this.send(ws, {
        type: "agentError",
        message:
          "WebRTC audio unavailable: no loopback device (install BlackHole/VB-Cable, see README); video will stream with silent audio",
      });
    }
    this.deps.capture.stop();
    this.deps.audio.stop();
    const session: WebrtcSession = new WebrtcSession({
      videoFfmpegArgsFor: this.deps.webrtcFfmpegArgs.video,
      audioFfmpegArgs: this.deps.webrtcFfmpegArgs.audio,
      onStateChange: (active, error) => {
        // Guard against a stale session's callback firing after it was
        // replaced/dropped and a newer session (`this.webrtc`) took over.
        if (this.webrtc !== session) return;
        this.send(ws, { type: "webrtcState", active, error });
        if (!active) {
          session.close();
          this.webrtc = null;
        }
      },
    });
    this.webrtc = session;
    try {
      const sdp = await session.createOffer();
      this.send(ws, { type: "webrtcOffer", sdp });
    } catch (err) {
      this.send(ws, { type: "webrtcState", active: false, error: String(err) });
      if (this.webrtc === session) {
        session.close();
        this.webrtc = null;
      }
    }
  }

  /**
   * Stop the active WebRTC session (if any) and report the resulting state.
   * WebrtcSession.close() doesn't itself fire onStateChange (a deliberate
   * close isn't a failure), so this reports active:false explicitly instead
   * of silently tearing the session down with no client-visible confirmation.
   */
  private handleStopWebrtc(ws: WebSocket): void {
    if (!this.webrtc) {
      // No active session; still answer so a client that double-sent
      // stopWebrtc (or raced a stop with a server-side teardown) sees the
      // authoritative state instead of waiting forever.
      this.send(ws, { type: "webrtcState", active: false });
      return;
    }
    this.webrtc.close();
    this.webrtc = null;
    this.send(ws, { type: "webrtcState", active: false });
  }

  private async handleWebrtcAnswer(ws: WebSocket, sdp: string): Promise<void> {
    if (!this.webrtc) {
      this.send(ws, {
        type: "agentError",
        message: "webrtcAnswer received with no active WebRTC session",
      });
      return;
    }
    try {
      await this.webrtc.setAnswer(sdp);
    } catch {
      // onStateChange already reported the failure and cleared this.webrtc.
    }
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
    const abort = new AbortController();
    this.autotypeAbort = abort;
    try {
      const completed = await runAutotype(
        text,
        profile,
        { backend: this.deps.typingBackend, signal: abort.signal },
        { onProgress: (done, total) => this.send(ws, { type: "autotypeProgress", done, total }) },
      );
      this.send(ws, { type: "autotypeDone", cancelled: !completed });
    } finally {
      this.autotyping = false;
      this.autotypeAbort = null;
    }
  }
}
