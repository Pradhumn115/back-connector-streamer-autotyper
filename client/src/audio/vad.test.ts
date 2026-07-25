import { test } from "node:test";
import assert from "node:assert/strict";
import { concatFloat32, tailRms, segmentSpeech } from "./vad.js";

const SR = 16000;
/** Build `seconds` of a loud tone (speech stand-in) or silence. */
function tone(seconds: number, amp = 0.3): Float32Array {
  const a = new Float32Array(Math.round(seconds * SR));
  for (let i = 0; i < a.length; i++) a[i] = amp * Math.sin((2 * Math.PI * 200 * i) / SR);
  return a;
}
function silence(seconds: number): Float32Array {
  return new Float32Array(Math.round(seconds * SR));
}

test("segmentSpeech returns nothing for pure silence", () => {
  assert.deepEqual(segmentSpeech(silence(2), SR), []);
});

test("segmentSpeech extracts one segment from silence-speech-silence and trims it", () => {
  const buf = concatFloat32([silence(1), tone(1), silence(1)]); // 3s total, 1s speech
  const segs = segmentSpeech(buf, SR);
  assert.equal(segs.length, 1);
  const dur = segs[0].audio.length / SR;
  // ~1s of speech plus small padding, well under the full 3s (silence trimmed)
  assert.ok(dur > 0.8 && dur < 1.6, `segment ~${dur.toFixed(2)}s`);
});

test("segmentSpeech splits two utterances separated by a long pause", () => {
  const buf = concatFloat32([tone(0.8), silence(1.2), tone(0.8)]);
  const segs = segmentSpeech(buf, SR);
  assert.equal(segs.length, 2);
});

test("segmentSpeech keeps one utterance across a short gap", () => {
  const buf = concatFloat32([tone(0.5), silence(0.15), tone(0.5)]); // 150ms gap < 300ms
  const segs = segmentSpeech(buf, SR);
  assert.equal(segs.length, 1);
});

test("concatFloat32 joins chunks in order", () => {
  const out = concatFloat32([
    new Float32Array([1, 2]),
    new Float32Array([]),
    new Float32Array([3, 4, 5]),
  ]);
  assert.equal(out.length, 5);
  assert.deepEqual([...out], [1, 2, 3, 4, 5]);
});

test("concatFloat32 of nothing is empty", () => {
  assert.equal(concatFloat32([]).length, 0);
});

test("tailRms measures only the last N samples", () => {
  // loud head, silent tail
  const a = new Float32Array([1, 1, 1, 1, 0, 0, 0, 0]);
  assert.equal(tailRms(a, 4), 0); // tail is all zeros
  assert.equal(tailRms(a, 8), Math.sqrt(0.5)); // whole buffer: half energy
});

test("tailRms clamps tail length to the buffer and handles empty", () => {
  assert.equal(tailRms(new Float32Array([]), 100), 0);
  const a = new Float32Array([0.5, 0.5]);
  assert.ok(Math.abs(tailRms(a, 100) - 0.5) < 1e-6); // asks 100, only 2 exist
});

test("tailRms detects a silent tail below the live threshold", () => {
  const speech = new Float32Array(16000).map(() => 0.3); // 1s loud
  const withPause = concatFloat32([speech, new Float32Array(6400)]); // +0.4s silence
  // last 0.4s (6400 samples) is silence -> ~0 RMS, below 0.008 threshold
  assert.ok(tailRms(withPause, 6400) < 0.008);
  // but the last 0.4s of pure speech is well above it
  assert.ok(tailRms(speech, 6400) > 0.008);
});
