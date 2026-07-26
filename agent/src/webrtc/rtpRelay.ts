import { createSocket, type Socket } from "node:dgram";
import { spawn, type ChildProcess } from "node:child_process";
import { RtpPacket, type MediaStreamTrack } from "werift";

/**
 * Spawns an ffmpeg process that encodes into RTP over a local UDP port, and
 * relays every packet it emits into a werift MediaStreamTrack via writeRtp().
 * One instance per track (video or audio). Crash-only: if ffmpeg exits, the
 * relay just stops forwarding until stop()/start() is called again — mirrors
 * FfmpegCapture/AudioCapture's "no hot-loop respawn" behavior.
 */
/**
 * How much of ffmpeg's stderr to retain for the failure message. ffmpeg runs
 * at `-loglevel warning`/`error` on both relays, so it normally prints
 * nothing; this cap only guards against a pathological loop growing the
 * buffer without bound.
 */
const STDERR_TAIL_LIMIT = 4000;

/**
 * How many times to respawn ffmpeg after it dies on its own before giving up
 * and reporting the track as failed.
 *
 * Screen capture fails *transiently* for reasons that have nothing to do with
 * bad parameters, and the failure is not recoverable within the ffmpeg process
 * — it exits. On Windows, gdigrab exits with "Failed to capture image
 * (error 5)" (ERROR_ACCESS_DENIED) the moment a secure desktop takes over: a
 * UAC prompt, the lock screen, Ctrl+Alt+Del. For a remote-control tool,
 * triggering a UAC prompt on the far machine is an ordinary thing to do, so
 * treating the first such exit as terminal left video dead for the rest of the
 * session. Retrying covers that, and also covers a device-handoff race at
 * startup (WebRTC's capture spawns immediately after Classic's is killed).
 */
const MAX_RESPAWNS = 4;

/** Backoff before each respawn attempt, indexed by attempt number. */
const RESPAWN_DELAYS_MS = [250, 500, 1500, 3000];

/**
 * A process that survived at least this long counts as healthy, so the
 * respawn budget resets. Without this, a session that hits four separate UAC
 * prompts hours apart would exhaust the budget and fail on the fourth,
 * despite having recovered cleanly every time.
 */
const HEALTHY_RUN_MS = 10_000;

/** Last non-empty line of a captured stderr blob, for a one-line summary. */
function lastLine(text: string): string {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines[lines.length - 1] ?? "";
}

export class RtpRelay {
  private proc: ChildProcess | null = null;
  private socket: Socket | null = null;
  /** Bumped on every stop(); lets an in-flight start() detect it was cancelled. */
  private generation = 0;
  /** Kept so a respawn can re-attach to the same track. */
  private track: MediaStreamTrack | null = null;
  /** Respawns used since the last healthy run; reset by HEALTHY_RUN_MS. */
  private respawns = 0;
  private respawnTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly kind: "video" | "audio",
    /** Builds the full ffmpeg args given the chosen local RTP port. */
    private readonly buildArgs: (port: number) => string[],
    /**
     * Called when ffmpeg dies on its own (non-zero exit) while still the
     * current process, with a one-line reason. Omit for tracks whose loss
     * shouldn't tear the session down: the audio relay deliberately has no
     * handler, because this project's design is "video streams with silent
     * audio" when audio is unavailable (see connection/index.ts's
     * handleStartWebrtc), whereas a dead *video* encoder means a
     * permanently blank screen and must surface as a real error rather than
     * a session that reports itself connected forever.
     */
    private readonly onFatal?: (reason: string) => void,
  ) {}

  async start(track: MediaStreamTrack): Promise<void> {
    this.stop();
    this.track = track;
    const generation = this.generation;
    const port = await randomUdpPort();
    if (generation !== this.generation) {
      // stop() was called while we were awaiting the port; abandon setup.
      return;
    }
    const socket = createSocket("udp4");
    // Each ffmpeg process starts a BRAND NEW RTP stream: random initial
    // sequence number, random initial timestamp. werift's RTCRtpSender adds a
    // fixed seqOffset/timestampOffset to every outgoing packet and only
    // recomputes them in replaceRTP(), which it wires to
    // `track.onSourceChanged`. Without firing that on a respawn, the new
    // process's fresh numbering flows out with the *previous* process's
    // offsets applied — an enormous sequence/timestamp discontinuity that
    // stalls the browser's depacketizer for good. Symptom: video plays fine,
    // then freezes permanently the first time ffmpeg restarts.
    //
    // Announcing the first packet of every spawn re-bases those offsets so
    // the outgoing stream stays continuous across restarts. Safe on the very
    // first spawn too: replaceRTP() no-ops while the sender has no previous
    // sequence number.
    let announcedSource = false;
    socket.on("message", (data) => {
      try {
        const packet = RtpPacket.deSerialize(data);
        if (!announcedSource) {
          announcedSource = true;
          track.onSourceChanged.execute(packet.header);
        }
        track.writeRtp(packet);
      } catch (err) {
        process.stderr.write(`[webrtc:${this.kind}] bad RTP packet: ${String(err)}\n`);
      }
    });
    socket.on("error", (err) => {
      process.stderr.write(`[webrtc:${this.kind}] RTP socket error: ${String(err)}\n`);
    });
    socket.bind(port, "127.0.0.1");
    this.socket = socket;

    // stderr is piped, not ignored: at -loglevel warning/error ffmpeg only
    // speaks up when something is actually wrong, and discarding it meant a
    // failed encoder (bad codec params, unavailable capture device, odd
    // frame dimensions) reported nothing but a bare exit code -- leaving a
    // WebRTC session that claims to be connected while streaming no video.
    const proc = spawn("ffmpeg", this.buildArgs(port), { stdio: ["ignore", "ignore", "pipe"] });
    this.proc = proc;
    let stderrTail = "";
    // Prefix every LINE, not every chunk: a single stderr "data" event often
    // carries several lines, so prefixing the chunk left lines 2..n
    // unattributed and looking like they came from some other process —
    // actively misleading when diagnosing which ffmpeg failed. Partial lines
    // are held back until their newline arrives.
    let linePartial = "";
    proc.stderr?.setEncoding("utf8");
    proc.stderr?.on("data", (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_LIMIT);
      const lines = (linePartial + chunk).split("\n");
      linePartial = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) process.stderr.write(`[webrtc:${this.kind}] ffmpeg: ${line}\n`);
      }
    });
    proc.stderr?.on("end", () => {
      if (linePartial.trim()) {
        process.stderr.write(`[webrtc:${this.kind}] ffmpeg: ${linePartial}\n`);
      }
      linePartial = "";
    });
    proc.on("error", (err) => {
      process.stderr.write(`[webrtc:${this.kind}] ffmpeg spawn error: ${String(err)}\n`);
    });
    const spawnedAt = Date.now();
    proc.on("exit", (code) => {
      // Capture identity *before* clearing: stop() sets this.proc to null and
      // SIGKILLs (exit code null), and a restart replaces it — neither is a
      // failure, so only a still-current process exiting non-zero reports.
      const wasCurrent = this.proc === proc;
      if (wasCurrent) this.proc = null;
      if (code === null || code === 0) return;

      const detail = stderrTail.trim();
      process.stderr.write(
        `[webrtc:${this.kind}] ffmpeg exited with code ${code}` +
          (detail ? `:\n${detail}\n` : "\n"),
      );
      if (!wasCurrent) return;

      // A process that ran a good while before dying was working; don't hold
      // its earlier retries against the next failure.
      if (Date.now() - spawnedAt >= HEALTHY_RUN_MS) this.respawns = 0;

      const summary = lastLine(detail);
      if (this.respawns >= MAX_RESPAWNS) {
        this.onFatal?.(
          `${this.kind} encoder failed after ${this.respawns} restarts (ffmpeg exit ${code})` +
            (summary ? `: ${summary}` : ""),
        );
        return;
      }

      const delay = RESPAWN_DELAYS_MS[Math.min(this.respawns, RESPAWN_DELAYS_MS.length - 1)];
      this.respawns++;
      process.stderr.write(
        `[webrtc:${this.kind}] restarting ffmpeg in ${delay}ms ` +
          `(attempt ${this.respawns}/${MAX_RESPAWNS})\n`,
      );
      const generationAtExit = this.generation;
      const trackAtExit = this.track;
      this.respawnTimer = setTimeout(() => {
        this.respawnTimer = null;
        // stop() (or another start()) happened while we were waiting — the
        // relay is no longer ours to restart.
        if (generationAtExit !== this.generation || !trackAtExit) return;
        void this.start(trackAtExit);
      }, delay);
      this.respawnTimer.unref?.();
    });
  }

  stop(): void {
    this.generation++;
    if (this.respawnTimer) {
      clearTimeout(this.respawnTimer);
      this.respawnTimer = null;
    }
    // NOT reset here: start() calls stop() first, so a respawn (which goes
    // through start()) would zero its own budget and retry forever. The
    // counter is cleared only by a genuinely healthy run (HEALTHY_RUN_MS);
    // a fresh session gets a fresh RtpRelay instance, and therefore a fresh
    // counter, for free.
    this.track = null;
    if (this.proc) {
      this.proc.kill("SIGKILL");
      this.proc = null;
    }
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
  }
}

/** Bind to port 0 to let the OS pick a free UDP port, then read it back. */
function randomUdpPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createSocket("udp4");
    probe.bind(0, "127.0.0.1", () => {
      const port = (probe.address() as { port: number }).port;
      probe.close(() => resolve(port));
    });
    probe.on("error", reject);
  });
}
