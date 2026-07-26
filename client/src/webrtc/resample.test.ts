import { test } from "node:test";
import assert from "node:assert/strict";
import { resampleTo16kMono } from "./resample.js";

test("downmixes stereo to mono by averaging channels", () => {
  // interleaved stereo, both channels constant but different values
  const input = new Float32Array([1, -1, 1, -1, 1, -1, 1, -1]);
  const out = resampleTo16kMono(input, 16000, 2);
  for (const s of out) assert.ok(Math.abs(s - 0) < 1e-6);
});

test("resamples 48kHz mono down to 16kHz mono, roughly a third the length", () => {
  const input = new Float32Array(4800).fill(0.5);
  const out = resampleTo16kMono(input, 48000, 1);
  assert.ok(Math.abs(out.length - 1600) <= 1, `expected ~1600, got ${out.length}`);
  for (const s of out) assert.ok(Math.abs(s - 0.5) < 1e-6);
});

test("passthrough when already 16kHz mono", () => {
  const input = new Float32Array([0.1, 0.2, 0.3]);
  const out = resampleTo16kMono(input, 16000, 1);
  assert.equal(out.length, 3);
  assert.deepEqual(Array.from(out), Array.from(input));
});
