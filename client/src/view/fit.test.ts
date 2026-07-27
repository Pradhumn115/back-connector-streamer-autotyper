import { test } from "node:test";
import assert from "node:assert/strict";
import { backingStoreSize, computeFitRect } from "./fit.js";

/** A 16:9 source in a 4:3 box — the box is relatively taller than the source. */
const SRC = { w: 1920, h: 1080 };
const BOX = { w: 800, h: 600 };

const round = (r: { dx: number; dy: number; dw: number; dh: number }) => ({
  dx: Math.round(r.dx),
  dy: Math.round(r.dy),
  dw: Math.round(r.dw),
  dh: Math.round(r.dh),
});

test("contain shows the whole image, letterboxed and centred", () => {
  const r = computeFitRect("contain", SRC.w, SRC.h, BOX.w, BOX.h);
  // Width-limited: 800/1920 < 600/1080, so it spans the full width.
  assert.deepEqual(round(r), { dx: 0, dy: 75, dw: 800, dh: 450 });
  // Nothing spills outside the box.
  assert.ok(r.dx >= 0 && r.dy >= 0);
  assert.ok(r.dx + r.dw <= BOX.w + 0.001 && r.dy + r.dh <= BOX.h + 0.001);
  // Aspect ratio preserved.
  assert.ok(Math.abs(r.dw / r.dh - SRC.w / SRC.h) < 1e-9);
});

test("cover fills the box, cropping the overflow evenly", () => {
  const r = computeFitRect("cover", SRC.w, SRC.h, BOX.w, BOX.h);
  // Height-limited here, so it overflows horizontally.
  assert.deepEqual(round(r), { dx: -133, dy: 0, dw: 1067, dh: 600 });
  // Covers the box in both axes.
  assert.ok(r.dw >= BOX.w - 1e-9 && r.dh >= BOX.h - 1e-9);
  // Cropped equally left and right.
  assert.ok(Math.abs(r.dx - (BOX.w - r.dx - r.dw)) < 1e-9);
  assert.ok(Math.abs(r.dw / r.dh - SRC.w / SRC.h) < 1e-9);
});

test("stretch fills the box exactly and distorts", () => {
  const r = computeFitRect("stretch", SRC.w, SRC.h, BOX.w, BOX.h);
  assert.deepEqual(round(r), { dx: 0, dy: 0, dw: 800, dh: 600 });
  assert.ok(Math.abs(r.dw / r.dh - SRC.w / SRC.h) > 0.1, "aspect is not preserved");
});

test("actual maps one source pixel to one canvas pixel, centred", () => {
  const r = computeFitRect("actual", SRC.w, SRC.h, BOX.w, BOX.h);
  assert.equal(r.dw, SRC.w);
  assert.equal(r.dh, SRC.h);
  // Larger than the box, so it is centred with negative offsets.
  assert.deepEqual({ dx: Math.round(r.dx), dy: Math.round(r.dy) }, { dx: -560, dy: -240 });
});

test("a source smaller than the box is centred at 1:1 in actual, and scaled up in contain", () => {
  const actual = computeFitRect("actual", 200, 100, BOX.w, BOX.h);
  assert.deepEqual(round(actual), { dx: 300, dy: 250, dw: 200, dh: 100 });

  const contain = computeFitRect("contain", 200, 100, BOX.w, BOX.h);
  assert.deepEqual(round(contain), { dx: 0, dy: 100, dw: 800, dh: 400 });
});

test("a square source in a square box is identical in every mode", () => {
  const modes = ["contain", "cover", "stretch"] as const;
  for (const m of modes) {
    assert.deepEqual(
      round(computeFitRect(m, 500, 500, 300, 300)),
      { dx: 0, dy: 0, dw: 300, dh: 300 },
      `mode ${m}`,
    );
  }
});

test("degenerate sizes produce an empty rect rather than NaN", () => {
  const cases: [number, number, number, number][] = [
    [0, 1080, 800, 600],
    [1920, 0, 800, 600],
    [1920, 1080, 0, 600],
    [1920, 1080, 800, 0],
  ];
  for (const [sw, sh, dw, dh] of cases) {
    const r = computeFitRect("contain", sw, sh, dw, dh);
    assert.deepEqual(r, { dx: 0, dy: 0, dw: 0, dh: 0 });
    // An empty rect is what makes the control layer fall back to the canvas box.
    assert.ok(Number.isFinite(r.dw) && Number.isFinite(r.dh));
  }
});

test("backing store scales by pixel ratio for crispness", () => {
  // Source is far larger than the box, so a 2x display is fully usable.
  const r = backingStoreSize(400, 300, 1920, 1080, 2);
  assert.deepEqual(r, { width: 800, height: 600 });
});

test("backing store never allocates beyond the source resolution", () => {
  // Box already larger than the source: upscaling to 2x would interpolate
  // pixels that do not exist, and cost memory every frame to do it.
  const r = backingStoreSize(1920, 1080, 1920, 1080, 2);
  assert.deepEqual(r, { width: 1920, height: 1080 });

  // Partially source-limited: allowed up to the point of upscaling, not past.
  const partial = backingStoreSize(1200, 675, 1920, 1080, 3);
  assert.deepEqual(partial, { width: 1920, height: 1080 });
});

test("backing store never goes below the CSS box", () => {
  // A tiny source must not shrink the canvas below its displayed size, or the
  // picture would be resampled up by the browser and look soft.
  const r = backingStoreSize(800, 600, 100, 50, 2);
  assert.deepEqual(r, { width: 800, height: 600 });
});

test("backing store tolerates a missing or absurd pixel ratio", () => {
  assert.deepEqual(backingStoreSize(400, 300, 1920, 1080, 0), { width: 400, height: 300 });
  assert.deepEqual(backingStoreSize(400, 300, 1920, 1080, NaN), { width: 400, height: 300 });
});
