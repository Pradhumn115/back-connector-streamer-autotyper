import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { platform } from "node:os";
import { FrameFormat } from "@bcsa/shared";
import type { CapturedImage, FrameHandler, ScreenCapture } from "./index.js";

export interface FfmpegCaptureOptions {
  /** Max output width in pixels; height auto to keep aspect. Default 1920. */
  maxWidth?: number;
  /** MJPEG quality 2 (best) .. 31 (worst). Default 6. */
  quality?: number;
}

/** True if an `ffmpeg` binary is on PATH. */
export function ffmpegAvailable(): boolean {
  try {
    return spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

/**
 * Continuous screen capture via ffmpeg, emitting a stream of JPEG frames. Unlike
 * the per-frame screenshot approach (which spawns a process each grab and caps
 * at a few fps), ffmpeg keeps one capture session open and can sustain ~30fps.
 *
 * setInterval(ms) maps to a target framerate (fps = 1000/ms, clamped 1..60).
 * Changing it restarts ffmpeg with the new rate.
 */
export class FfmpegCapture implements ScreenCapture {
  private proc: ChildProcess | null = null;
  private handler: FrameHandler | null = null;
  private fps = 15;
  private running = false;
  private buf: Buffer = Buffer.alloc(0);
  private readonly maxWidth: number;
  private readonly quality: number;

  constructor(opts: FfmpegCaptureOptions = {}) {
    this.maxWidth = opts.maxWidth ?? 1920;
    this.quality = opts.quality ?? 6;
  }

  start(handler: FrameHandler): void {
    this.handler = handler;
    this.running = true;
    this.spawnFfmpeg();
  }

  setInterval(ms: number): void {
    // Cap at 120fps; the real ceiling is the display refresh rate (e.g. 60Hz,
    // or 120Hz on ProMotion) and available bandwidth.
    const fps = Math.min(120, Math.max(1, Math.round(1000 / ms)));
    if (fps === this.fps) return;
    this.fps = fps;
    if (this.running) this.spawnFfmpeg(); // restart at the new rate
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
    this.killProc();
    this.buf = Buffer.alloc(0);

    const args = this.buildArgs();
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "ignore"] });
    this.proc = proc;

    proc.stdout?.on("data", (chunk: Buffer) => this.onData(chunk));
    proc.on("error", (err) => {
      process.stderr.write(`[ffmpeg] spawn error: ${String(err)}\n`);
    });
    proc.on("exit", (code) => {
      // If we're still meant to be running, a non-null exit means it crashed;
      // don't hot-loop — the next setInterval/start will respawn.
      if (this.running && this.proc === proc) this.proc = null;
      if (this.running && code !== null && code !== 0) {
        process.stderr.write(`[ffmpeg] exited with code ${code}\n`);
      }
    });
  }

  private buildArgs(): string[] {
    const common = [
      "-loglevel", "error",
      // fps filter caps the OUTPUT rate: screen-capture inputs (esp. macOS
      // avfoundation) ignore the input -framerate and would otherwise emit
      // frames as fast as possible. scale keeps width <= maxWidth (even height).
      "-vf", `fps=${this.fps},scale='min(${this.maxWidth},iw)':-2`,
      "-c:v", "mjpeg",
      "-q:v", String(this.quality),
      "-f", "mjpeg",
      "pipe:1",
    ];
    return [...screenCaptureInputArgs(this.fps), ...common];
  }

  private onData(chunk: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    // Extract every complete JPEG in the buffer. We walk the JPEG marker
    // structure (respecting segment lengths) rather than scanning for raw
    // FFD8/FFD9 bytes, because those byte pairs legitimately occur inside
    // header tables (DQT/DHT) and would otherwise split a frame incorrectly.
    for (;;) {
      const soi = findSoi(this.buf);
      if (soi < 0) return;
      if (soi > 0) this.buf = this.buf.subarray(soi); // drop leading junk
      const end = jpegEnd(this.buf);
      if (end < 0) return; // incomplete; wait for more data
      const jpeg = this.buf.subarray(0, end);
      this.buf = this.buf.subarray(end);
      if (this.handler) {
        const image: CapturedImage = { data: new Uint8Array(jpeg), format: FrameFormat.JPEG };
        this.handler(image);
      }
    }
  }
}

/** Index of the next JPEG SOI (FF D8), or -1. */
function findSoi(buf: Buffer): number {
  for (let i = 0; i < buf.length - 1; i++) {
    if (buf[i] === 0xff && buf[i + 1] === 0xd8) return i;
  }
  return -1;
}

/**
 * Given a buffer whose start is a JPEG SOI, return the index just past the EOI
 * of that single JPEG, or -1 if the buffer doesn't yet contain the whole frame.
 * Walks marker segments and skips entropy-coded scan data (handling byte
 * stuffing and restart markers), so it never mistakes table bytes for markers.
 */
function jpegEnd(buf: Buffer): number {
  let i = 2; // past SOI (FF D8)
  while (i < buf.length - 1) {
    if (buf[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = buf[i + 1];
    if (marker === 0xff) {
      i++; // fill byte
      continue;
    }
    if (marker === 0xd9) return i + 2; // EOI
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      i += 2; // standalone marker (RSTn / TEM), no length
      continue;
    }
    if (i + 3 >= buf.length) return -1; // need the 2-byte length
    const len = (buf[i + 2] << 8) | buf[i + 3];
    if (marker === 0xda) {
      // SOS: skip its header, then scan entropy data for the next real marker.
      let j = i + 2 + len;
      while (j < buf.length - 1) {
        if (buf[j] === 0xff) {
          const m = buf[j + 1];
          if (m === 0x00 || (m >= 0xd0 && m <= 0xd7)) {
            j += 2; // stuffed FF or restart marker: part of scan data
            continue;
          }
          break; // real marker (e.g. EOI) begins here
        }
        j++;
      }
      if (j >= buf.length - 1) return -1;
      i = j;
      continue;
    }
    i += 2 + len; // skip this segment
  }
  return -1;
}

/**
 * Per-OS screen-capture input args (`-f <format> ... -i <device>`), shared by
 * FfmpegCapture's MJPEG-over-pipe pipeline and the WebRTC RTP pipeline (see
 * agent/src/index.ts) — both grab the same screen, they only differ in the
 * encoder/output tail appended after this.
 */
export function screenCaptureInputArgs(fps: number): string[] {
  switch (platform()) {
    case "darwin":
      return [
        "-f", "avfoundation",
        "-capture_cursor", "1",
        "-framerate", String(fps),
        "-i", `${macScreenDevice()}:none`,
      ];
    case "win32":
      return ["-f", "gdigrab", "-framerate", String(fps), "-i", "desktop"];
    default:
      return [
        "-f", "x11grab",
        "-framerate", String(fps),
        "-i", process.env.DISPLAY || ":0.0",
      ];
  }
}

let cachedMacDevice: string | null = null;
/**
 * The avfoundation device index for "Capture screen 0" varies per machine, so
 * detect it once by parsing ffmpeg's device list. Falls back to "1".
 */
function macScreenDevice(): string {
  if (cachedMacDevice !== null) return cachedMacDevice;
  cachedMacDevice = "1";
  try {
    const res = spawnSync("ffmpeg", ["-f", "avfoundation", "-list_devices", "true", "-i", ""], {
      encoding: "utf8",
    });
    const text = `${res.stdout ?? ""}${res.stderr ?? ""}`;
    const m = text.match(/\[(\d+)\]\s+Capture screen 0/i);
    if (m) cachedMacDevice = m[1];
  } catch {
    /* keep fallback */
  }
  return cachedMacDevice;
}
