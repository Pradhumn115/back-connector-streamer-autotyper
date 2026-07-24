import { FrameFormat } from "@bcsa/shared";

export interface CapturedImage {
  data: Uint8Array;
  format: FrameFormat;
}

/** Grabs a single screenshot. Injectable so the loop can be tested. */
export type CaptureFn = () => Promise<CapturedImage>;

export type FrameHandler = (image: CapturedImage) => void;

/**
 * Repeatedly captures the screen at a configurable interval and hands each
 * frame to a callback. Uses a self-scheduling timer (not setInterval) so a slow
 * capture never overlaps or piles up: the next capture is scheduled only after
 * the previous one finishes.
 */
export class CaptureLoop {
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
