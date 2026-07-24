import { test } from "node:test";
import assert from "node:assert/strict";
import { mapToNormalized } from "./mapCoords.js";

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
