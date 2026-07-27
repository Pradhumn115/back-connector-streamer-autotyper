import { FrameFormat } from "@bcsa/shared";

export interface CapturedImage {
  data: Uint8Array;
  format: FrameFormat;
  /**
   * Whether this frame is independently decodable. JPEG/PNG always are; H.264
   * delta frames are not, and a receiver must discard everything until it sees
   * a keyframe. Defaults to true so the intra-only paths need not set it.
   */
  keyframe?: boolean;
}

/** Grabs a single screenshot. Injectable so the loop can be tested. */
export type CaptureFn = () => Promise<CapturedImage>;

export type FrameHandler = (image: CapturedImage) => void;

/**
 * Common shape for a screen-capture source so the server can use either the
 * per-frame screenshot loop or the continuous ffmpeg pipeline interchangeably.
 */
export interface ScreenCapture {
  start(handler: FrameHandler): void;
  /**
   * Change the encoder's target bitrate, if this engine has one.
   *
   * Optional because the MJPEG engines have no bitrate to set — their size per
   * frame follows the JPEG quality setting, not a rate target. Implemented by
   * the H.264 engine, where reopening the encoder costs ~2.2ms and is what
   * makes continuous adaptation practical.
   */
  setBitrate?(kbps: number): void;
  /**
   * Re-open at a smaller frame size and/or lower frame rate.
   *
   * Separate from setBitrate because it is the lever of last resort: once
   * bitrate is at its floor there are not enough bits to describe this many
   * pixels this often, and the picture turns to mush rather than degrading.
   * Spending the remaining budget on fewer pixels or fewer frames is what keeps
   * text legible on a bad link.
   */
  setScale?(width: number, fps: number): void;
  /** Encoder actually in use, when the engine has a choice to report. */
  readonly activeEncoder?: string | null;
  /** Current encode width, for a controller stepping relative to it. */
  readonly encodeWidth?: number;
  /** Current encode frame rate. */
  readonly encodeFps?: number;
  /** Set the desired cadence; interpreted as an interval (ms) between frames. */
  setInterval(ms: number): void;
  stop(): void;
}

/**
 * Repeatedly captures the screen at a configurable interval and hands each
 * frame to a callback. Uses a self-scheduling timer (not setInterval) so a slow
 * capture never overlaps or piles up: the next capture is scheduled only after
 * the previous one finishes.
 */
export class CaptureLoop implements ScreenCapture {
  private intervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private handler: FrameHandler | null = null;

  constructor(
    private readonly capture: CaptureFn,
    initialIntervalMs = 2000,
  ) {
    this.intervalMs = initialIntervalMs;
  }

  start(handler: FrameHandler): void {
    if (this.running) return;
    this.handler = handler;
    this.running = true;
    void this.tick();
  }

  setInterval(ms: number): void {
    this.intervalMs = ms;
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.handler = null;
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    const startedAt = Date.now();
    try {
      const image = await this.capture();
      if (this.running && this.handler) this.handler(image);
    } catch (err) {
      // Swallow a single failed grab; the loop keeps going. Callers that care
      // about capture health can layer their own logging over the handler.
      process.stderr.write(`[capture] frame failed: ${String(err)}\n`);
    }
    if (!this.running) return;
    const elapsed = Date.now() - startedAt;
    const wait = Math.max(0, this.intervalMs - elapsed);
    this.timer = setTimeout(() => void this.tick(), wait);
  }
}

/** Real capture using screenshot-desktop (JPEG). Lazily imported. */
export function createScreenshotCapture(): CaptureFn {
  return async (): Promise<CapturedImage> => {
    const mod = await import("screenshot-desktop");
    const screenshot = mod.default;
    const buf = await screenshot({ format: "jpg" });
    return { data: new Uint8Array(buf), format: FrameFormat.JPEG };
  };
}
