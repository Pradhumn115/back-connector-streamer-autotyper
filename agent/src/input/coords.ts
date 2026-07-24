/**
 * Translate a normalized coordinate (0..1) from the client into an integer
 * pixel coordinate on the agent's screen. Values are clamped to the valid
 * pixel range so a slightly-out-of-range client value can't land off-screen.
 */
export function toPixel(normalized: number, screenSize: number): number {
  const clamped = Math.min(1, Math.max(0, normalized));
  const px = Math.round(clamped * (screenSize - 1));
  return Math.min(screenSize - 1, Math.max(0, px));
}
