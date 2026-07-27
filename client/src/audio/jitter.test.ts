import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkDuration, scheduleChunk } from "./jitter.js";

const TARGET = 0.15;
const MAX = 0.6;
const DUR = 0.1;

test("the first chunk starts one target latency ahead, not immediately", () => {
  const s = scheduleChunk(0, 10, DUR, TARGET, MAX);
  assert.equal(s.startAt, 10.15);
  assert.equal(s.nextTime, 10.25);
  // A fresh start is not a resync — there was no schedule to lose.
  assert.equal(s.resynced, false);
});

test("healthy chunks are laid end to end with no gap", () => {
  let next = 0;
  let now = 10;
  const starts: number[] = [];
  for (let i = 0; i < 5; i++) {
    const s = scheduleChunk(next, now, DUR, TARGET, MAX);
    assert.equal(s.resynced, false, `chunk ${i} should not resync`);
    starts.push(s.startAt);
    next = s.nextTime;
    now += DUR; // arriving in real time
  }
  // Each start is exactly one duration after the previous: no gaps, no overlap.
  for (let i = 1; i < starts.length; i++) {
    assert.ok(Math.abs(starts[i] - (starts[i - 1] + DUR)) < 1e-9, `gap before chunk ${i}`);
  }
});

test("an underrun resyncs instead of scheduling in the past", () => {
  // The schedule ended at 10.25 but the clock has moved to 12: a two-second
  // stall. Continuing from 10.25 would ask for audio in the past.
  const s = scheduleChunk(10.25, 12, DUR, TARGET, MAX);
  assert.equal(s.resynced, true);
  assert.equal(s.startAt, 12.15);
  assert.ok(s.startAt > 12, "never schedules in the past");
});

test("an overrun resyncs so the delay cannot ratchet upwards", () => {
  // A burst after a stall pushed the queue to 1.2s, well past the ceiling.
  const s = scheduleChunk(11.2, 10, DUR, TARGET, MAX);
  assert.equal(s.resynced, true);
  assert.equal(s.startAt, 10.15);
  // The queue is back to the target rather than staying a second behind.
  assert.ok(s.startAt - 10 <= MAX);
});

test("a queue at exactly the ceiling is left alone", () => {
  const s = scheduleChunk(10 + MAX, 10, DUR, TARGET, MAX);
  assert.equal(s.resynced, false);
  assert.equal(s.startAt, 10 + MAX);
});

test("a burst of early arrivals is absorbed, then trimmed at the ceiling", () => {
  // Chunks arriving with the clock standing still: the queue grows and is
  // eventually cut back rather than growing without bound.
  let next = 0;
  const now = 10;
  let resyncs = 0;
  let maxQueue = 0;
  for (let i = 0; i < 40; i++) {
    const s = scheduleChunk(next, now, DUR, TARGET, MAX);
    if (s.resynced) resyncs++;
    next = s.nextTime;
    maxQueue = Math.max(maxQueue, next - now);
  }
  assert.ok(resyncs > 0, "must trim at some point");
  assert.ok(maxQueue <= MAX + DUR + 1e-9, `queue grew to ${maxQueue}`);
});

test("recovers to steady scheduling after a stall", () => {
  let next = scheduleChunk(0, 10, DUR, TARGET, MAX).nextTime;
  // Long stall, then resume.
  const after = scheduleChunk(next, 30, DUR, TARGET, MAX);
  assert.equal(after.resynced, true);
  // The chunk that follows is back to gapless.
  const then = scheduleChunk(after.nextTime, 30 + DUR, DUR, TARGET, MAX);
  assert.equal(then.resynced, false);
  assert.ok(Math.abs(then.startAt - after.nextTime) < 1e-9);
});

test("chunkDuration converts frames to seconds", () => {
  // 1600 mono samples at 16 kHz is 100 ms.
  assert.ok(Math.abs(chunkDuration(1600, 16000, 1) - 0.1) < 1e-9);
  // Stereo interleaves, so the same sample count is half the time.
  assert.ok(Math.abs(chunkDuration(1600, 16000, 2) - 0.05) < 1e-9);
});

test("chunkDuration refuses to divide by zero", () => {
  assert.equal(chunkDuration(1600, 0, 1), 0);
  assert.equal(chunkDuration(1600, 16000, 0), 0);
});
