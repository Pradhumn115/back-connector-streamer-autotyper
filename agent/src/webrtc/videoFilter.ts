import type { VideoCodecTier } from "./codecs.js";
import { captureFilterPrefix } from "../capture/ffmpeg.js";

/**
 * Builds the `-vf` filter chain for a WebRTC video encode.
 *
 * Two invariants this must always hold, both learned from real failures:
 *
 *  1. **fps cap.** Screen-capture inputs (especially avfoundation) ignore
 *     `-framerate` and emit as fast as they can, so `fps=` is what actually
 *     paces the output — mirroring Classic capture's use of it.
 *
 *  2. **Even output dimensions.** libx264 with yuv420p (2x2 chroma
 *     subsampling) rejects an odd width or height outright — it logs
 *     "width not divisible by 2", fails to open the encoder, and writes zero
 *     packets. Before this was guarded, that surfaced as a WebRTC session
 *     reporting itself happily connected while the client rendered a
 *     permanently blank <video> (RtpRelay discarded ffmpeg's stderr, so
 *     nothing said why). Odd capture sizes are not exotic: Windows gdigrab
 *     grabs the *physical* desktop, and fractional DPI scaling routinely
 *     produces sizes like 1707x1067.
 *
 * `scale`'s `-2` for height rounds to a multiple of 2, but the width side
 * needs `trunc(iw/2)*2` explicitly — capping with `min(maxWidth, iw)` alone
 * passes an odd `iw` straight through whenever it's already under the cap.
 * The uncapped (high) tier crops instead of scaling: it drops at most one
 * row/column and skips resampling entirely.
 */
export function buildVideoFilter(tier: VideoCodecTier): string {
  const fps = `fps=${tier.maxFps}`;
  const chain =
    tier.maxWidth === null
      ? `${fps},crop=trunc(iw/2)*2:trunc(ih/2)*2`
      : `${fps},scale='min(${tier.maxWidth},trunc(iw/2)*2)':-2`;
  // Prefixed (not appended): a hardware-frame capture backend has to be
  // downloaded to system memory before any of the above can run on it.
  return `${captureFilterPrefix()}${chain}`;
}
