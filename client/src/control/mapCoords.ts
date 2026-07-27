import type { ContentRect } from "../view/ScreenView";

/**
 * Map a pixel position within the canvas (relative to the canvas's top-left)
 * onto normalized 0..1 coordinates of the *frame image*, accounting for the
 * letterbox rectangle the image occupies. Falls back to the full canvas box
 * when no frame has been drawn yet. Result is clamped to [0, 1].
 */
/**
 * Map a pointer position onto normalized image coordinates, converting from CSS
 * pixels to the canvas's backing-store pixels on the way.
 *
 * The two are not the same unit. Pointer events report CSS pixels; the content
 * rectangle is computed while drawing and is therefore in backing-store pixels,
 * which are a device-pixel-ratio multiple of CSS pixels on a high-DPI display.
 * Treating them as interchangeable puts every click at half its intended
 * position on a 2x screen — and looks perfectly correct on a 1x one, which is
 * why this conversion is stated explicitly rather than left implicit.
 */
export function mapPointerToNormalized(
  clientX: number,
  clientY: number,
  /** The canvas's CSS box, from getBoundingClientRect. */
  box: { left: number; top: number; width: number; height: number },
  /** The canvas's backing-store dimensions. */
  store: { width: number; height: number },
  content: ContentRect,
): { x: number; y: number } {
  const scaleX = box.width > 0 ? store.width / box.width : 1;
  const scaleY = box.height > 0 ? store.height / box.height : 1;
  return mapToNormalized(
    (clientX - box.left) * scaleX,
    (clientY - box.top) * scaleY,
    content,
    store.width,
    store.height,
  );
}

export function mapToNormalized(
  px: number,
  py: number,
  content: ContentRect,
  canvasWidth: number,
  canvasHeight: number,
): { x: number; y: number } {
  let x: number;
  let y: number;
  if (content.dw > 0 && content.dh > 0) {
    x = (px - content.dx) / content.dw;
    y = (py - content.dy) / content.dh;
  } else {
    x = canvasWidth > 0 ? px / canvasWidth : 0;
    y = canvasHeight > 0 ? py / canvasHeight : 0;
  }
  return {
    x: Math.min(1, Math.max(0, x)),
    y: Math.min(1, Math.max(0, y)),
  };
}
