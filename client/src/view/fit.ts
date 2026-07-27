import type { ContentRect } from "./ScreenView";

/**
 * How the remote screen is laid out inside the viewing area.
 *
 * ## Why this is one shared function rather than per-path drawing code
 *
 * There are two sources that paint the same canvas — decoded H.264 frames and
 * MJPEG images — and they had drifted apart. The MJPEG path computed a
 * letterbox rectangle; the H.264 path sized the canvas to the frame and drew at
 * the origin, leaving CSS to stretch the element to its box. On a phone that
 * displayed a 1.55-aspect desktop at 0.86, a 45% distortion: everything tall
 * and thin.
 *
 * Worse, the control layer maps clicks through the rectangle published here, so
 * two different notions of "where the image is" meant clicks could be mapped by
 * one path's geometry while the other path drew it. One function, used by both,
 * removes the possibility.
 */
export type FitMode = "contain" | "cover" | "stretch" | "actual";

export const FIT_MODES: { value: FitMode; label: string; hint: string }[] = [
  { value: "contain", label: "Fit", hint: "Whole screen visible, bars if the shape differs" },
  { value: "cover", label: "Fill", hint: "Fills the area, edges cropped" },
  { value: "stretch", label: "Stretch", hint: "Fills the area, aspect ratio distorted" },
  { value: "actual", label: "1:1", hint: "One remote pixel per screen pixel, centred" },
];

/**
 * Where to draw a `srcW`x`srcH` frame inside a `dstW`x`dstH` area.
 *
 * The result is always the full image rectangle, which may extend beyond the
 * destination — for `cover` and `actual` that is the point, and the canvas
 * clips it. The control layer needs the whole rectangle regardless, because it
 * maps a click back onto image coordinates: a rectangle truncated to the
 * visible part would mis-scale every click.
 */
export function computeFitRect(
  mode: FitMode,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
): ContentRect {
  if (srcW <= 0 || srcH <= 0 || dstW <= 0 || dstH <= 0) {
    return { dx: 0, dy: 0, dw: 0, dh: 0 };
  }

  if (mode === "stretch") {
    return { dx: 0, dy: 0, dw: dstW, dh: dstH };
  }

  const scale =
    mode === "actual"
      ? 1
      : mode === "cover"
        ? Math.max(dstW / srcW, dstH / srcH)
        : Math.min(dstW / srcW, dstH / srcH);

  const dw = srcW * scale;
  const dh = srcH * scale;
  // Centred in every mode: with `contain` the bars are even, and with `cover`
  // and `actual` the crop takes equally from opposite edges, which keeps the
  // middle of the remote screen in the middle of the view.
  return { dx: (dstW - dw) / 2, dy: (dstH - dh) / 2, dw, dh };
}

/**
 * Backing-store size for a canvas occupying `cssW`x`cssH`, given the source.
 *
 * Two competing concerns. Drawing at CSS-pixel size looks soft on a high-DPI
 * display, so the store is scaled by the device pixel ratio. But allocating
 * beyond the source resolution buys nothing — the extra pixels are interpolated
 * from data that does not exist — and costs memory on every frame, so the
 * ratio is capped at the point where the source would be upscaled.
 */
export function backingStoreSize(
  cssW: number,
  cssH: number,
  srcW: number,
  srcH: number,
  devicePixelRatio: number,
): { width: number; height: number } {
  const w = Math.max(1, Math.round(cssW));
  const h = Math.max(1, Math.round(cssH));
  if (srcW <= 0 || srcH <= 0) return { width: w, height: h };

  const dpr = Math.max(1, devicePixelRatio || 1);
  // The largest ratio at which some axis of the source is still downscaled.
  const sourceLimited = Math.max(srcW / w, srcH / h);
  const ratio = Math.max(1, Math.min(dpr, sourceLimited));
  return { width: Math.round(w * ratio), height: Math.round(h * ratio) };
}
