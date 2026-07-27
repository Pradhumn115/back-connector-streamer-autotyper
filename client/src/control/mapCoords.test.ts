import { test } from "node:test";
import assert from "node:assert/strict";
import { mapPointerToNormalized, mapToNormalized } from "./mapCoords.js";

// Canvas 1000x800; a 1000x500 image is letterboxed: scale=min(1000/1000,800/500)=1,
// so dw=1000, dh=500, centered -> dx=0, dy=150. Image occupies y in [150, 650].
const letterboxed = { dx: 0, dy: 150, dw: 1000, dh: 500 };

test("center of the image maps to (0.5, 0.5), not center of canvas", () => {
  // Center of the IMAGE is at canvas y = 150 + 250 = 400 (which is also canvas
  // center here), x = 500.
  const c = mapToNormalized(500, 400, letterboxed, 1000, 800);
  assert.ok(Math.abs(c.x - 0.5) < 1e-9);
  assert.ok(Math.abs(c.y - 0.5) < 1e-9);
});

test("top edge of the image (not canvas) maps to y=0", () => {
  const c = mapToNormalized(500, 150, letterboxed, 1000, 800);
  assert.ok(Math.abs(c.y - 0) < 1e-9);
});

test("bottom edge of the image maps to y=1", () => {
  const c = mapToNormalized(500, 650, letterboxed, 1000, 800);
  assert.ok(Math.abs(c.y - 1) < 1e-9);
});

test("regression: without letterbox correction the old math was wrong", () => {
  // Old (buggy) behavior normalized against full canvas height: a click at the
  // image's vertical center (canvas y=400) would give 400/800 = 0.5 which is
  // coincidentally right here, but a click at image-top (y=150) gave 150/800 =
  // 0.1875 instead of 0. Verify the fix yields 0.
  const c = mapToNormalized(500, 150, letterboxed, 1000, 800);
  assert.notEqual(c.y.toFixed(4), (150 / 800).toFixed(4));
  assert.equal(c.y, 0);
});

test("clicks in the letterbox bar clamp to [0,1]", () => {
  const top = mapToNormalized(500, 10, letterboxed, 1000, 800); // above image
  assert.equal(top.y, 0);
  const bottom = mapToNormalized(500, 790, letterboxed, 1000, 800); // below image
  assert.equal(bottom.y, 1);
});

test("side letterbox: tall image in wide canvas maps x correctly", () => {
  // Canvas 1000x800, image 500x800 -> dw=500, dh=800, dx=250, dy=0.
  const sideBox = { dx: 250, dy: 0, dw: 500, dh: 800 };
  const left = mapToNormalized(250, 400, sideBox, 1000, 800);
  assert.equal(left.x, 0);
  const right = mapToNormalized(750, 400, sideBox, 1000, 800);
  assert.equal(right.x, 1);
  const mid = mapToNormalized(500, 400, sideBox, 1000, 800);
  assert.ok(Math.abs(mid.x - 0.5) < 1e-9);
});

test("falls back to full canvas box before any frame is drawn", () => {
  const empty = { dx: 0, dy: 0, dw: 0, dh: 0 };
  const c = mapToNormalized(250, 400, empty, 1000, 800);
  assert.ok(Math.abs(c.x - 0.25) < 1e-9);
  assert.ok(Math.abs(c.y - 0.5) < 1e-9);
});

// --- CSS pixels vs backing-store pixels -------------------------------------
// The canvas is displayed at 400x300 CSS px but, on a 2x display, its backing
// store is 800x600 — and the content rect is computed while drawing, so it is
// in backing-store units. A 1x display hides this entirely, which is why it
// gets its own tests.

/** 800x600 store, a 800x400 image centred: dy = 100. */
const hidpiContent = { dx: 0, dy: 100, dw: 800, dh: 400 };
const cssBox = { left: 0, top: 0, width: 400, height: 300 };
const store2x = { width: 800, height: 600 };

test("a click at the centre of a 2x canvas maps to the centre of the image", () => {
  const c = mapPointerToNormalized(200, 150, cssBox, store2x, hidpiContent);
  assert.ok(Math.abs(c.x - 0.5) < 1e-9, `x=${c.x}`);
  assert.ok(Math.abs(c.y - 0.5) < 1e-9, `y=${c.y}`);
});

test("without the ratio conversion a 2x click would land at half position", () => {
  // The old behaviour: CSS pixels fed straight into a backing-store rectangle.
  const wrong = mapToNormalized(200, 150, hidpiContent, store2x.width, store2x.height);
  assert.ok(Math.abs(wrong.x - 0.25) < 1e-9, "quarter across, not half");
  // Proof the conversion is load-bearing rather than incidental.
  const right = mapPointerToNormalized(200, 150, cssBox, store2x, hidpiContent);
  assert.notDeepEqual(round3(right), round3(wrong));
});

test("the right edge of a 2x canvas maps to the right edge of the image", () => {
  const c = mapPointerToNormalized(400, 150, cssBox, store2x, hidpiContent);
  assert.ok(Math.abs(c.x - 1) < 1e-9, `x=${c.x}`);
});

test("the canvas's offset on the page is subtracted before scaling", () => {
  const offset = { left: 40, top: 20, width: 400, height: 300 };
  const c = mapPointerToNormalized(40 + 200, 20 + 150, offset, store2x, hidpiContent);
  assert.ok(Math.abs(c.x - 0.5) < 1e-9);
  assert.ok(Math.abs(c.y - 0.5) < 1e-9);
});

test("a 1x display is unaffected by the conversion", () => {
  const box1x = { left: 0, top: 0, width: 1000, height: 800 };
  const store1x = { width: 1000, height: 800 };
  const c = mapPointerToNormalized(500, 400, box1x, store1x, letterboxed);
  assert.ok(Math.abs(c.x - 0.5) < 1e-9);
  assert.ok(Math.abs(c.y - 0.5) < 1e-9);
});

function round3(p: { x: number; y: number }) {
  return { x: +p.x.toFixed(3), y: +p.y.toFixed(3) };
}
