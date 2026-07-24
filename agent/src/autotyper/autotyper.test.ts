import { test } from "node:test";
import assert from "node:assert/strict";
import { runAutotype, type TypingBackend } from "./index.js";

function recorder() {
  const events: string[] = [];
  const backend: TypingBackend = {
    async typeChar(ch) {
      events.push(ch);
    },
    async backspace() {
      events.push("<BS>");
    },
  };
  return { events, backend };
}

const noSleep = async (): Promise<void> => {};

test("types the exact text when typoRate is 0", async () => {
  const { events, backend } = recorder();
  await runAutotype(
    "hello",
    { baseDelayMs: 10, jitterMs: 5, typoRate: 0 },
    { backend, sleep: noSleep, rng: () => 0.5 },
  );
  assert.equal(events.join(""), "hello");
});

test("reports progress for every character", async () => {
  const { backend } = recorder();
  const progress: Array<[number, number]> = [];
  await runAutotype(
    "abc",
    { baseDelayMs: 0, jitterMs: 0, typoRate: 0 },
    { backend, sleep: noSleep, rng: () => 0.9 },
    { onProgress: (done, total) => progress.push([done, total]) },
  );
  assert.deepEqual(progress, [
    [1, 3],
    [2, 3],
    [3, 3],
  ]);
});

test("injects a typo + backspace + correction when rng forces it", async () => {
  const { events, backend } = recorder();
  // rng always returns 0 -> typoRate check (0 < rate) triggers, and adjacent
  // index 0 is chosen. Final text must still be correct.
  await runAutotype(
    "a",
    { baseDelayMs: 0, jitterMs: 0, typoRate: 1 },
    { backend, sleep: noSleep, rng: () => 0 },
  );
  // For 'a', neighbors = "sqwz", index 0 -> 's'. So: s, <BS>, a
  assert.deepEqual(events, ["s", "<BS>", "a"]);
});

test("delay stays non-negative even with large jitter", async () => {
  const { backend } = recorder();
  const waited: number[] = [];
  await runAutotype(
    "xy",
    { baseDelayMs: 5, jitterMs: 1000, typoRate: 0 },
    {
      backend,
      sleep: async (ms) => {
        waited.push(ms);
      },
      rng: () => 0, // jitter = (0*2-1)*1000 = -1000 -> clamps to 0
    },
  );
  assert.ok(waited.every((w) => w >= 0));
});

test("preserves case when correcting an uppercase typo", async () => {
  const { events, backend } = recorder();
  await runAutotype(
    "A",
    { baseDelayMs: 0, jitterMs: 0, typoRate: 1 },
    { backend, sleep: noSleep, rng: () => 0 },
  );
  // 'A' neighbors from 'a' = "sqwz"[0] = 's' -> uppercased 'S'
  assert.deepEqual(events, ["S", "<BS>", "A"]);
});
