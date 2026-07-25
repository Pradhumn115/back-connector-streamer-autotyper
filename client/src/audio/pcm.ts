/**
 * Convert interleaved signed-16-bit little-endian PCM into Float32 samples in
 * [-1, 1) — the format Whisper expects. Uses a DataView so it's correct
 * regardless of the byte offset/alignment of the incoming slice.
 */
export function pcmS16ToFloat32(bytes: Uint8Array): Float32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = Math.floor(bytes.byteLength / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = view.getInt16(i * 2, true) / 32768;
  }
  return out;
}

/**
 * Accumulates a stream of Float32 samples and emits fixed-size windows for the
 * transcriber. `hopSamples` is how far the window advances each step; equal to
 * `windowSamples` means non-overlapping windows (v1: no dedup needed).
 */
export class AudioWindower {
  private buf = new Float32Array(0);

  constructor(
    private readonly windowSamples: number,
    private readonly hopSamples: number,
  ) {}

  /** Add samples; return any windows that are now complete (possibly none). */
  push(samples: Float32Array): Float32Array[] {
    const merged = new Float32Array(this.buf.length + samples.length);
    merged.set(this.buf);
    merged.set(samples, this.buf.length);
    this.buf = merged;

    const out: Float32Array[] = [];
    while (this.buf.length >= this.windowSamples) {
      out.push(this.buf.slice(0, this.windowSamples));
      this.buf = this.buf.slice(this.hopSamples);
    }
    return out;
  }

  reset(): void {
    this.buf = new Float32Array(0);
  }
}
