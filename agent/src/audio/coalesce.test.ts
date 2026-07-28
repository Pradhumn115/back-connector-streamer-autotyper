import { test } from "node:test";
import assert from "node:assert/strict";
import { CoalescingApplier } from "./coalesce.js";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Records what actually reached the (slow) work function. */
function applier(workMs = 20) {
  const applied: number[] = [];
  const a = new CoalescingApplier<number>(async (v) => {
    await tick(workMs);
    applied.push(v);
  });
  return { a, applied };
}

test("a burst ends on the last value requested", async () => {
  const { a, applied } = applier();
  // Twenty positions arriving faster than one can be applied, as a drag does.
  const sends = [];
  for (let i = 0; i < 20; i++) sends.push(a.set(20 + i * 3));
  await Promise.all(sends);
  await tick(100); // let anything still queued drain

  // The regression this exists for: a real drag ending on 77 left the machine
  // at 65, because each await resumed in its own turn.
  assert.equal(applied.at(-1), 77, `finished at ${applied.at(-1)}, not the released position`);
});

test("intermediate positions are dropped rather than queued", async () => {
  const { a, applied } = applier();
  const sends = [];
  for (let i = 0; i < 20; i++) sends.push(a.set(i));
  await Promise.all(sends);
  await tick(100);

  assert.ok(applied.length < 20, `applied ${applied.length} of 20 — nothing was coalesced`);
  assert.ok(applied.length >= 1, "at least one must be applied");
});

test("changes made slowly are each applied, not swallowed", async () => {
  const { a, applied } = applier(5);
  await a.set(10);
  await a.set(20);
  await a.set(30);
  // Coalescing must not lose deliberate, separated adjustments.
  assert.deepEqual(applied, [10, 20, 30]);
});

test("a value of 0 is not mistaken for 'nothing requested'", async () => {
  // Guarding on a nullable field rather than an explicit flag would drop this,
  // and 0 is exactly the value a mute-by-slider produces.
  const { a, applied } = applier(1);
  await a.set(0);
  assert.deepEqual(applied, [0]);
});

test("busy reports whether work is still draining", async () => {
  const { a } = applier(30);
  assert.equal(a.busy, false, "idle before anything is requested");
  const pending = a.set(1);
  assert.equal(a.busy, true, "busy while applying");
  await pending;
  assert.equal(a.busy, false, "idle once drained");
});

test("a failing change does not wedge the applier permanently", async () => {
  let calls = 0;
  const applied: number[] = [];
  const a = new CoalescingApplier<number>(async (v) => {
    calls++;
    if (calls === 1) throw new Error("OS refused");
    applied.push(v);
  });
  await assert.rejects(() => a.set(50));
  assert.equal(a.busy, false, "must not stay busy after a throw");

  // Otherwise every later change would be accepted and silently never applied.
  await a.set(60);
  assert.deepEqual(applied, [60]);
});
