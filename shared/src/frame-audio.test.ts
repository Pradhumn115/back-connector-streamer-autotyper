import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AudioFormat,
  encodeAudioFrame,
  decodeAudioFrame,
  isAudioFrame,
} from "./frame-audio.js";
import { encodeFrame, isFrame, FrameFormat } from "./frame.js";

test("encode -> decode round-trips all audio header fields and payload", () => {
  const pcm = new Uint8Array([1, 2, 3, 4, 250, 251, 252, 253]);
  const buf = encodeAudioFrame(42, 1234.5, 16000, 1, AudioFormat.PCM_S16LE, pcm);
  const decoded = decodeAudioFrame(buf);
  assert.ok(decoded);
  assert.equal(decoded.seq, 42);
  assert.equal(decoded.timestamp, 1234.5);
  assert.equal(decoded.sampleRate, 16000);
  assert.equal(decoded.channels, 1);
  assert.equal(decoded.format, AudioFormat.PCM_S16LE);
  assert.deepEqual([...decoded.payload], [...pcm]);
});

test("decodeAudioFrame rejects too-short and wrong-magic buffers", () => {
  assert.equal(decodeAudioFrame(new Uint8Array(4)), null);
  assert.equal(decodeAudioFrame(new Uint8Array(24)), null); // all-zero magic
});

test("isAudioFrame and isFrame are mutually exclusive (routing relies on this)", () => {
  const audio = encodeAudioFrame(1, 0, 16000, 1, AudioFormat.PCM_S16LE, new Uint8Array([9]));
  const video = encodeFrame(1, 0, FrameFormat.JPEG, new Uint8Array([0xff, 0xd8]));

  assert.equal(isAudioFrame(audio), true);
  assert.equal(isFrame(audio), false);

  assert.equal(isFrame(video), true);
  assert.equal(isAudioFrame(video), false);
});

test("empty payload is valid (header-only audio frame)", () => {
  const buf = encodeAudioFrame(0, 0, 16000, 1, AudioFormat.PCM_S16LE, new Uint8Array(0));
  const decoded = decodeAudioFrame(buf);
  assert.ok(decoded);
  assert.equal(decoded.payload.byteLength, 0);
});
