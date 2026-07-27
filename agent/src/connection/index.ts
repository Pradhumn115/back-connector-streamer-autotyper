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
  /** Human-readable capture engine actually in use, surfaced in diagnostics. */
  captureKind?: string;
  /** Starting point for the adaptive bitrate controller, in kbit/s. */
  initialBitrateKbps?: number;
  /**
   * QUIC/WebTransport video listener, when one started. Frames prefer it and
   * fall back to the WebSocket whenever no client is attached to it.
   */
  webtransport?: {
    port: number;
    certHash: string | null;
    hasSession: boolean;
    /** Bytes written to QUIC but not yet flushed; the congestion signal there. */
    backlogBytes: number;
    send(payload: Uint8Array): Promise<boolean>;
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
 * H.264 sends far less (measured ~7.4KB/frame against MJPEG's ~267KB), so
 * this ceiling is reached rarely on that path — but it is what keeps a
 * saturated link from queueing rather than dropping, on either codec.
 */
const MAX_QUEUED_FRAME_BYTES = 512 * 1024;

/** Minimum gap between "dropping frames" log lines. */
const DROP_LOG_THROTTLE_MS = 5000;

/**
 * Bitrate bounds and step sizes for the adaptive controller below.
 *
 * The floor is chosen so a saturated link still carries a legible desktop
 * rather than degrading to mush; the ceiling is what a good LAN can spend
 * without the encoder becoming the limit. Steps are asymmetric on purpose:
 * congestion is an emergency and should be answered immediately, while
 * recovery should be cautious, because probing upward too eagerly re-creates
 * the congestion that was just escaped.
 */
const BITRATE_MIN_KBPS = 400;
/**
 * Ceiling, raised for LAN.
 *
 * Resolution and bitrate are not independent: spreading 6 Mbit/s over a native
 * desktop looks SOFTER than the same bits over 1280px, because quality is
 * bits-per-pixel. Raising the frame size without raising this would have made
 * the picture worse, not better. The controller still walks down from here on
 * any link that cannot sustain it, so a constrained connection never pays for
 * the higher ceiling.
 */
const BITRATE_MAX_KBPS = 20000;
const BITRATE_DOWN_FACTOR = 0.6;
const BITRATE_UP_FACTOR = 1.15;

/** How often the controller reconsiders quality. */
const ADAPT_INTERVAL_MS = 2000;

/**
 * Frame widths to fall back through when bitrate alone cannot rescue the link,
 * and the frame rates paired with them.
 *
 * Ordered best-first. Resolution is given up before frame rate at the top of
 * the ladder, because for a remote desktop a slightly smaller sharp image beats
 * a large mushy one; frame rate is only halved once the picture is already
 * small, where smoothness starts to matter more than detail.
 */
const QUALITY_LADDER: ReadonlyArray<{ width: number; fps: number }> = [
  { width: 1920, fps: 60 },
  { width: 1920, fps: 30 },
  { width: 1280, fps: 30 },
  { width: 960, fps: 30 },
  { width: 960, fps: 15 },
  { width: 640, fps: 15 },
];

/**
 * Consecutive healthy checks required before climbing back up a rung.
 *
 * Stepping resolution reopens the encoder and forces a keyframe, which is a
 * visible cost, so it must not oscillate. Coming down is immediate — congestion
 * is already hurting — but going up waits for sustained evidence that the link
 * can hold it.
 */
const LADDER_RECOVERY_CHECKS = 5;

/**
 * Queue depth that counts as "the link is behind".
 *
 * Deliberately below MAX_QUEUED_FRAME_BYTES: by the time frames are being
 * dropped the viewer has already seen the damage, so the controller reacts to
 * the queue growing rather than waiting for it to overflow.
 */
const ADAPT_BACKLOG_BYTES = 192 * 1024;

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
  /** Frames dropped for backpressure since the last log line. */
  private droppedFrames = 0;
  private lastDropLogAt = 0;
  /** Current adaptive target; null until a capture engine that supports it starts. */
  private bitrateKbps: number | null = null;
  private adaptTimer: NodeJS.Timeout | null = null;
  /** Worst queue depth seen since the last adaptation decision. */
  private peakBacklog = 0;
  /** Index into QUALITY_LADDER; 0 is best. */
  private ladderRung = 0;
  /** Consecutive healthy checks, for cautious recovery up the ladder. */
  private healthyChecks = 0;
  /** Frames dropped since the last adaptation decision. */
  private dropsSinceAdapt = 0;

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
    this.stopAdapting();
    this.deps.capture.stop();
    this.deps.audio.stop();
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
   * Adjusts encoder bitrate to what the link is actually carrying.
   *
   * The signal is the socket's own send queue. That is a real measurement of
   * whether the far end is keeping up — unlike a fixed bitrate, which is a
   * guess that is wrong in both directions: too high on a poor link (frames
   * queue, then get dropped, and the picture stutters) and too low on a good
   * one (bandwidth sits unused while the image stays soft).
   *
   * Down fast, up slow. Congestion is already hurting the viewer when it is
   * detected, so it is answered in one large step; recovery probes gently,
   * because climbing back too eagerly just re-creates the congestion. This is
   * the same asymmetry TCP uses, for the same reason.
   *
   * Cheap enough to do continuously: reopening the encoder measures ~2.2ms,
   * against ~300ms plus a capture-device reopen when the encoder was an ffmpeg
   * subprocess — which is precisely why this was not worth attempting before.
   */
  private startAdapting(): void {
    if (this.adaptTimer || !this.deps.capture.setBitrate) return;
    this.bitrateKbps ??= this.deps.initialBitrateKbps ?? 2500;
    this.adaptTimer = setInterval(() => {
      const ws = this.controller;
      if (!ws || ws.readyState !== ws.OPEN || this.bitrateKbps === null) return;

      // Read the queue of whichever transport is actually carrying video.
      //
      // Using the WebSocket's queue unconditionally was wrong once QUIC
      // existed: on that path the socket carries only control messages, so it
      // always looked idle and the controller raised the bitrate to the ceiling
      // no matter how congested the link really was.
      const wt = this.deps.webtransport;
      const live = wt?.hasSession ? wt.backlogBytes : ws.bufferedAmount;
      const backlog = Math.max(this.peakBacklog, live);
      const drops = this.dropsSinceAdapt;
      this.peakBacklog = 0;
      this.dropsSinceAdapt = 0;

      const congested = drops > 0 || backlog > ADAPT_BACKLOG_BYTES;

      // Resolution and frame rate move only when bitrate has run out of room.
      // Bitrate is the cheap, invisible lever; changing frame size reopens the
      // encoder and forces a keyframe, so it is reserved for links that cannot
      // be rescued by spending fewer bits on the same picture.
      if (this.deps.capture.setScale) {
        if (congested && this.bitrateKbps <= BITRATE_MIN_KBPS) {
          this.healthyChecks = 0;
          if (this.ladderRung < QUALITY_LADDER.length - 1) {
            this.ladderRung++;
            this.applyRung("still congested at the bitrate floor");
          }
        } else if (!congested && this.bitrateKbps >= BITRATE_MAX_KBPS) {
          // Only climb back when bitrate is already maxed AND the link has been
          // quiet for a while: stepping up prematurely re-creates the
          // congestion that forced the step down.
          this.healthyChecks++;
          if (this.healthyChecks >= LADDER_RECOVERY_CHECKS && this.ladderRung > 0) {
            this.healthyChecks = 0;
            this.ladderRung--;
            this.applyRung("link sustained at full bitrate");
          }
        } else {
          this.healthyChecks = 0;
        }
      }

      const previous = this.bitrateKbps;
      const next = congested
        ? Math.max(BITRATE_MIN_KBPS, Math.round(previous * BITRATE_DOWN_FACTOR))
        : Math.min(BITRATE_MAX_KBPS, Math.round(previous * BITRATE_UP_FACTOR));

      // Ignore changes too small to matter: every adjustment reopens the
      // encoder and emits a keyframe, which costs far more bytes than a 3%
      // bitrate tweak would ever save.
      //
      // Except when the step lands on a bound. Suppressing those strands the
      // controller just short of its own floor — a 420 -> 400 step is under
      // 10%, so it was skipped forever, and the quality ladder below (which
      // only engages AT the floor) could never trigger no matter how congested
      // the link became.
      const atBound = next === BITRATE_MIN_KBPS || next === BITRATE_MAX_KBPS;
      if (!atBound && Math.abs(next - previous) < previous * 0.1) return;
      if (next === previous) return;

      this.bitrateKbps = next;
      this.deps.capture.setBitrate?.(next);
      process.stderr.write(
        `[adapt] ${previous} -> ${next} kbps ` +
          `(${congested ? `backlog ${(backlog / 1024).toFixed(0)}KB, ${drops} dropped` : "link healthy"})\n`,
      );
    }, ADAPT_INTERVAL_MS);
    this.adaptTimer.unref?.();
  }

  /** Applies the current ladder rung to the encoder and says why. */
  private applyRung(reason: string): void {
    const rung = QUALITY_LADDER[this.ladderRung];
    this.deps.capture.setScale?.(rung.width, rung.fps);
    process.stderr.write(
      `[adapt] quality -> ${rung.width}px @ ${rung.fps}fps (${reason})\n`,
    );
  }

  private stopAdapting(): void {
    if (this.adaptTimer) {
      clearInterval(this.adaptTimer);
      this.adaptTimer = null;
    }
    this.peakBacklog = 0;
    this.dropsSinceAdapt = 0;
    this.ladderRung = 0;
    this.healthyChecks = 0;
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
        `Lower the frame rate or resolution for a smoother stream.\n`,
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
        this.stopAdapting();
        this.deps.audio.stop();
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
        // Sent only after auth: the certificate hash is what lets a client
        // open a QUIC session to a self-signed listener, so it goes to
        // clients that have already proved they know the secret.
        webtransport:
          this.deps.webtransport?.certHash != null
            ? { port: this.deps.webtransport.port, certHash: this.deps.webtransport.certHash }
            : undefined,
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
   * (Re)starts the frame-capture loop with the standard forwarding callback.
   * `capture.start()` is safe to call again (it just restarts the pipeline),
   * so this can be called when capture is already running.
   */
  private startCapture(): void {
    this.startAdapting();
    this.deps.capture.start((image) => {
      const ws = this.controller;
      if (ws?.readyState !== ws?.OPEN || !ws) return;

      // Drop rather than queue once the socket is already behind. Encoding is
      // skipped too, not just the send: a frame that would only be dropped is
      // not worth the JPEG encode. See MAX_QUEUED_FRAME_BYTES for why an
      // unbounded queue here made Classic drift permanently behind real time.
      const wtSend = this.deps.webtransport;
      const queued = wtSend?.hasSession ? wtSend.backlogBytes : ws.bufferedAmount;
      if (queued > this.peakBacklog) this.peakBacklog = queued;
      if (ws.bufferedAmount > (this.deps.maxQueuedFrameBytes ?? MAX_QUEUED_FRAME_BYTES)) {
        this.droppedFrames++;
        this.dropsSinceAdapt++;
        this.logDroppedFrames(ws.bufferedAmount);
        return;
      }

      // `keyframe` matters only for H.264, where a delta frame is undecodable
      // without the keyframe it references. Intra-only formats (JPEG/PNG) leave
      // it undefined and default to true, since every such frame stands alone.
      const buf = encodeFrame(
        this.seq++,
        Date.now(),
        image.format,
        image.data,
        image.keyframe ?? true,
      );

      // Prefer QUIC when a client is attached to it: each frame gets its own
      // stream, so loss in one never blocks the next, which TCP cannot offer.
      // The same envelope goes over either transport, so the client decodes
      // identically and the fallback is invisible.
      const wt = this.deps.webtransport;
      if (wt?.hasSession) {
        void wt.send(new Uint8Array(buf)).then((sent) => {
          // Nobody actually took it (session died between the check and the
          // write): fall back rather than silently dropping the frame.
          if (!sent && ws.readyState === ws.OPEN) ws.send(buf, { binary: true });
        });
        return;
      }
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
          // Capture may not be running yet on the first setMode; start it.
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
      captureKind: this.deps.captureKind,
      videoEncoder: this.deps.capture.activeEncoder ?? null,
      videoWidth: this.deps.capture.encodeWidth ?? null,
      videoFps: this.deps.capture.encodeFps ?? null,
      webtransportPort: this.deps.webtransport?.certHash ? this.deps.webtransport.port : null,
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
