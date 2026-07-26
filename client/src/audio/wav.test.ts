import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeWav } from "./wav";
import { pcmS16ToFloat32 } from "./pcm";

const ascii = (view: DataView, offset: number, len: number) =>
  Array.from({ length: len }, (_, i) => String.fromCharCode(view.getUint8(offset + i))).join("");

async function headerOf(blob: Blob): Promise<DataView> {
  return new DataView(await blob.arrayBuffer());
}

test("writes a canonical RIFF/WAVE header for 16-bit mono PCM", async () => {
  const samples = new Float32Array(8);
  const view = await headerOf(encodeWav(samples, 16000));

  assert.equal(ascii(view, 0, 4), "RIFF");
  assert.equal(ascii(view, 8, 4), "WAVE");
  assert.equal(ascii(view, 12, 4), "fmt ");
  assert.equal(ascii(view, 36, 4), "data");

  assert.equal(view.getUint32(16, true), 16, "PCM fmt chunk body is 16 bytes");
  assert.equal(view.getUint16(20, true), 1, "format 1 = uncompressed PCM");
  assert.equal(view.getUint16(22, true), 1, "mono");
  assert.equal(view.getUint32(24, true), 16000, "sample rate");
  assert.equal(view.getUint16(34, true), 16, "bits per sample");

  // byteRate = sampleRate * blockAlign, blockAlign = channels * bits/8
  assert.equal(view.getUint16(32, true), 2, "block align");
  assert.equal(view.getUint32(28, true), 16000 * 2, "byte rate");
});

test("declares sizes that match the actual payload", async () => {
  const samples = new Float32Array(100);
  const blob = encodeWav(samples, 16000);
  const view = await headerOf(blob);

  const dataBytes = samples.length * 2;
  assert.equal(view.getUint32(40, true), dataBytes, "data chunk size");
  // RIFF size counts everything after the first 8 bytes.
  assert.equal(view.getUint32(4, true), blob.size - 8, "RIFF chunk size");
  assert.equal(blob.size, 44 + dataBytes, "header + payload");
});

test("round-trips sample values through the s16 payload", async () => {
  const samples = Float32Array.from([0, 0.5, -0.5, 0.999]);
  const buf = await encodeWav(samples, 16000).arrayBuffer();
  const decoded = pcmS16ToFloat32(new Uint8Array(buf, 44));

  assert.equal(decoded.length, samples.length);
  for (let i = 0; i < samples.length; i++) {
    assert.ok(
      Math.abs(decoded[i] - samples[i]) < 1e-4,
      `sample ${i}: ${decoded[i]} vs ${samples[i]}`,
    );
  }
});

test("clamps out-of-range samples instead of wrapping", async () => {
  const buf = await encodeWav(Float32Array.from([2, -2]), 16000).arrayBuffer();
  const view = new DataView(buf, 44);
  // Wrapping (rather than clamping) would flip the sign of these.
  assert.equal(view.getInt16(0, true), 32767);
  assert.equal(view.getInt16(2, true), -32767);
});

test("handles an empty take without producing a malformed file", async () => {
  const blob = encodeWav(new Float32Array(0), 16000);
  const view = await headerOf(blob);
  assert.equal(blob.size, 44);
  assert.equal(view.getUint32(40, true), 0);
  assert.equal(view.getUint32(4, true), 36);
});
