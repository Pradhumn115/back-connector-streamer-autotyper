import { spawn, type ChildProcess } from "node:child_process";
import { detectLoopbackDevice, type LoopbackDevice } from "./detect.js";

/** A chunk of raw PCM audio (interleaved s16le). */
export type AudioChunkHandler = (pcm: Uint8Array) => void;

/** Target sample rate / channels: 16 kHz mono is Whisper's native input. */
const SAMPLE_RATE = 16000;
const CHANNELS = 1;
// Flush roughly every 100ms: 16000 samples/s * 2 bytes * 0.1s = 3200 bytes.
const FRAME_BYTES = SAMPLE_RATE * 2 * CHANNELS * 0.1;

/**
 * Continuous system-audio (loopback) capture via ffmpeg, emitting raw 16 kHz
 * mono s16le PCM in ~100ms chunks. Mirrors FfmpegCapture: one long-lived ffmpeg
 * process, killed on stop; a crash just stops the stream (the next start()
 * respawns). `supported` is false when no loopback device is present, so the
 * server can report the feature unavailable instead of streaming silence.
 */
export class AudioCapture {
  readonly supported: boolean;
  readonly sampleRate = SAMPLE_RATE;
  readonly channels = CHANNELS;

  private readonly loopback: LoopbackDevice | null;
  private proc: ChildProcess | null = null;
  private handler: AudioChunkHandler | null = null;
  private running = false;
  private buf: Buffer = Buffer.alloc(0);

  constructor(loopback: LoopbackDevice | null = detectLoopbackDevice()) {
    this.loopback = loopback;
    this.supported = loopback !== null;
  }

  start(handler: AudioChunkHandler): void {
    if (!this.loopback || this.running) return;
    this.handler = handler;
    this.running = true;
    this.spawnFfmpeg();
  }

  stop(): void {
    this.running = false;
    this.handler = null;
    this.killProc();
    this.buf = Buffer.alloc(0);
  }

  private killProc(): void {
    if (this.proc) {
      this.proc.kill("SIGKILL");
      this.proc = null;
    }
  }

  private spawnFfmpeg(): void {
    if (!this.loopback) return;
    this.killProc();
    this.buf = Buffer.alloc(0);

    const args = [
      "-hide_banner",
      "-loglevel", "error",
      "-f", this.loopback.format,
      "-i", this.loopback.device,
      "-ac", String(CHANNELS),
      "-ar", String(SAMPLE_RATE),
      "-f", "s16le",
      "pipe:1",
    ];
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "ignore"] });
    this.proc = proc;

    proc.stdout?.on("data", (chunk: Buffer) => this.onData(chunk));
    proc.on("error", (err) => {
      process.stderr.write(`[audio] ffmpeg spawn error: ${String(err)}\n`);
    });
    proc.on("exit", (code) => {
      if (this.running && this.proc === proc) this.proc = null;
      if (this.running && code !== null && code !== 0) {
        process.stderr.write(`[audio] ffmpeg exited with code ${code}\n`);
      }
    });
  }

  private onData(chunk: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    // Emit whole ~100ms frames; carry any remainder to the next chunk.
    while (this.buf.length >= FRAME_BYTES) {
      const frame = this.buf.subarray(0, FRAME_BYTES);
      this.buf = this.buf.subarray(FRAME_BYTES);
      this.handler?.(new Uint8Array(frame));
    }
  }
}

export { detectLoopbackDevice } from "./detect.js";
export type { LoopbackDevice } from "./detect.js";
