import type { ContentRect } from "../view/ScreenView";

/**
 * Map a pixel position within the canvas (relative to the canvas's top-left)
 * onto normalized 0..1 coordinates of the *frame image*, accounting for the
 * letterbox rectangle the image occupies. Falls back to the full canvas box
 * when no frame has been drawn yet. Result is clamped to [0, 1].
 */
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
