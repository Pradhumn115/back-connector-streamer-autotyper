import { test } from "node:test";
import assert from "node:assert/strict";
import { pcmS16ToFloat32, AudioWindower } from "./pcm.js";

/** Build a little-endian s16 byte buffer from sample values. */
function s16(samples: number[]): Uint8Array {
  const buf = new Uint8Array(samples.length * 2);
  const view = new DataView(buf.buffer);
  samples.forEach((s, i) => view.setInt16(i * 2, s, true));
  return buf;
}

test("pcmS16ToFloat32 maps full-scale values into [-1, 1)", () => {
  const f = pcmS16ToFloat32(s16([0, 32767, -32768, 16384]));
  assert.equal(f.length, 4);
  assert.equal(f[0], 0);
  assert.ok(Math.abs(f[1] - 0.99997) < 1e-4);
  assert.equal(f[2], -1); // -32768 / 32768
  assert.equal(f[3], 0.5);
});

test("pcmS16ToFloat32 works on a non-zero byteOffset slice (like a frame payload)", () => {
  // Simulate a 24-byte header followed by PCM, then take a subarray view.
  const whole = new Uint8Array(24 + 4);
  const body = s16([1000, -1000]);
  whole.set(body, 24);
  const payload = whole.subarray(24);
  const f = pcmS16ToFloat32(payload);
  assert.equal(f.length, 2);
  assert.ok(Math.abs(f[0] - 1000 / 32768) < 1e-6);
  assert.ok(Math.abs(f[1] + 1000 / 32768) < 1e-6);
});

test("AudioWindower emits nothing until a full window accumulates", () => {
  const w = new AudioWindower(4, 4);
  assert.deepEqual(w.push(new Float32Array([1, 2, 3])), []);
  const out = w.push(new Float32Array([4, 5]));
  assert.equal(out.length, 1);
  assert.deepEqual([...out[0]], [1, 2, 3, 4]);
});

test("AudioWindower with hop == window is non-overlapping", () => {
  const w = new AudioWindower(2, 2);
  const out = w.push(new Float32Array([1, 2, 3, 4, 5]));
  assert.equal(out.length, 2);
  assert.deepEqual([...out[0]], [1, 2]);
  assert.deepEqual([...out[1]], [3, 4]);
  // 5 remained buffered; adding 6 completes the next window
  const next = w.push(new Float32Array([6]));
  assert.equal(next.length, 1);
  assert.deepEqual([...next[0]], [5, 6]);
});

test("AudioWindower with hop < window overlaps", () => {
  const w = new AudioWindower(4, 2); // 50% overlap
  const out = w.push(new Float32Array([1, 2, 3, 4, 5, 6]));
  assert.equal(out.length, 2);
  assert.deepEqual([...out[0]], [1, 2, 3, 4]);
  assert.deepEqual([...out[1]], [3, 4, 5, 6]);
});

test("AudioWindower.reset clears buffered samples", () => {
  const w = new AudioWindower(4, 4);
  w.push(new Float32Array([1, 2]));
  w.reset();
  assert.deepEqual(w.push(new Float32Array([9, 9])), []);
});
