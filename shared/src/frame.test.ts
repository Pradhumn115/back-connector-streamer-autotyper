import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeFrame, decodeFrame, isFrame, FrameFormat } from "./frame.js";

test("frame roundtrips seq, timestamp, format, payload", () => {
  const payload = new Uint8Array([1, 2, 3, 4, 255, 0, 128]);
  const ts = 1_700_000_000_123.5;
  const buf = encodeFrame(42, ts, FrameFormat.JPEG, payload);
  const decoded = decodeFrame(buf);
  assert.ok(decoded);
  assert.equal(decoded!.seq, 42);
  assert.equal(decoded!.timestamp, ts);
  assert.equal(decoded!.format, FrameFormat.JPEG);
  assert.deepEqual(Array.from(decoded!.payload), Array.from(payload));
});

test("isFrame recognizes encoded frames and rejects garbage", () => {
  const buf = encodeFrame(1, 0, FrameFormat.JPEG, new Uint8Array([9]));
  assert.equal(isFrame(buf), true);
  assert.equal(isFrame(new Uint8Array([0, 0, 0, 0, 0])), false);
  assert.equal(isFrame(new Uint8Array([1, 2])), false);
});

test("decodeFrame returns null for non-frame data", () => {
  assert.equal(decodeFrame(new Uint8Array([1, 2, 3])), null);
  assert.equal(decodeFrame(new Uint8Array(20)), null); // right size, wrong magic
});

test("handles empty payload", () => {
  const buf = encodeFrame(0, 0, FrameFormat.PNG, new Uint8Array(0));
  const decoded = decodeFrame(buf);
  assert.ok(decoded);
  assert.equal(decoded!.payload.byteLength, 0);
  assert.equal(decoded!.format, FrameFormat.PNG);
});
