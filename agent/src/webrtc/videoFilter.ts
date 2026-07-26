import type { VideoCodecTier } from "./codecs.js";
import { captureFilterPrefix } from "../capture/ffmpeg.js";

/**
 * Builds the `-vf` filter chain for a WebRTC video encode.
 *
 * Three invariants this must hold, all learned from real failures:
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
 *     permanently blank <video>. Odd capture sizes are not exotic: Windows
 *     gdigrab grabs the *physical* desktop, and fractional DPI scaling
 *     routinely produces sizes like 1707x1067.
 *
 *  3. **The level's macroblock budget.** See below — this one is why a plain
 *     width cap was not enough.
 *
 * ## Why the width expression looks like that
 *
 * An H.264 level constrains FRAME AREA in macroblocks (MaxFS) and macroblocks
 * per second (MaxMBPS), not width. A width cap only coincides with the budget
 * at one aspect ratio: 1280 was chosen because 1280x720 is exactly level 3.1's
 * 3600 macroblocks — at 16:9. On a 3456x2234 (~1.55:1) Retina desktop the same
 * cap yields 1280x832 = 80x52 = 4160 macroblocks, and x264 does not silently
 * cope. It warns and still writes the requested level into the SPS, so the
 * browser negotiates level 3.1, receives a stream violating level 3.1, and
 * rejects every frame.
 *
 * So the width has to be bounded by AREA, exactly rather than by a fudge
 * factor. Writing `mb = ceil(w/16) * ceil(h/16)` and `h = w * ih/iw`, and
 * bounding the ceilings by `ceil(x/16) <= (x + 15)/16`:
 *
 *     (w + 15) * (h + 15) <= maxMacroblocks * 256
 *
 * Substituting `h = w * r` where `r = ih/iw` gives a quadratic in w:
 *
 *     r*w^2 + 15*(1 + r)*w + (225 - P) <= 0        where P = maxMacroblocks*256
 *
 * whose positive root is the largest conforming width:
 *
 *     w <= ( -15*(1 + r) + sqrt( 225*(1 + r)^2 + 4*r*(P - 225) ) ) / (2*r)
 *
 * That is what the expression below evaluates, then truncates to an even
 * number (invariant 2) and clamps to the tier's own width cap. Height stays
 * `-2`, so the aspect ratio is preserved exactly rather than being snapped to
 * a macroblock multiple.
 *
 * Verified against 15 aspect ratios from 4:3 to 16:9 to portrait, including
 * 5120x2880 and odd DPI-scaled sizes: the worst case reaches 3577 of level
 * 3.1's 3600 macroblocks — never over — while aspect error stays under 0.12%.
 * (Snapping both dimensions to multiples of 16 also bounds this exactly, but
 * distorts the aspect ratio by up to 2.2%, which is why it isn't used.)
 */
export function buildVideoFilter(tier: VideoCodecTier): string {
  const fps = `fps=${tier.maxFps}`;
  // P and r as they appear in the derivation above. `r` is written inline as
  // (ih/iw) because ffmpeg expressions have no variable bindings.
  const p = tier.maxMacroblocks * 256;
  const r = "(ih/iw)";
  const areaBound =
    `(-15*(1+${r})+sqrt(225*pow(1+${r},2)+4*${r}*(${p}-225)))/(2*${r})`;
  // A tier may also impose its own width cap; `iw` keeps this from upscaling a
  // source that is already smaller than either bound.
  const widthCap = tier.maxWidth === null ? "iw" : `min(${tier.maxWidth},iw)`;
  const width = `trunc(min(${widthCap},${areaBound})/2)*2`;
  // Prefixed (not appended): a hardware-frame capture backend has to be
  // downloaded to system memory before any of the above can run on it.
  return `${captureFilterPrefix()}${fps},scale=w='${width}':h=-2`;
}
