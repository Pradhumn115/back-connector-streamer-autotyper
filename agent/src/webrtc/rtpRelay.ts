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
    const generation = this.generation;
    const port = await randomUdpPort();
    if (generation !== this.generation) {
      // stop() was called while we were awaiting the port; abandon setup.
      return;
    }
    const socket = createSocket("udp4");
    socket.on("message", (data) => {
      try {
        track.writeRtp(RtpPacket.deSerialize(data));
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
    proc.on("exit", (code) => {
      // Capture identity *before* clearing: stop() sets this.proc to null and
      // SIGKILLs (exit code null), and a restart replaces it — neither is a
      // failure, so only a still-current process exiting non-zero reports.
      const wasCurrent = this.proc === proc;
      if (wasCurrent) this.proc = null;
      if (code !== null && code !== 0) {
        const detail = stderrTail.trim();
        process.stderr.write(
          `[webrtc:${this.kind}] ffmpeg exited with code ${code}` +
            (detail ? `:\n${detail}\n` : "\n"),
        );
        if (wasCurrent) {
          const summary = lastLine(detail);
          this.onFatal?.(
            `${this.kind} encoder failed (ffmpeg exit ${code})${summary ? `: ${summary}` : ""}`,
          );
        }
      }
    });
  }

  stop(): void {
    this.generation++;
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
