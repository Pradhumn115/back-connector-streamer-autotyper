import { test } from "node:test";
import assert from "node:assert/strict";
import { InputLockManager, type InputLockBackend } from "./index.js";

/** A controllable fake timer so tests can fire the watchdog deterministically. */
function fakeClock() {
  let seq = 0;
  const timers = new Map<number, () => void>();
  return {
    setTimer(fn: () => void): ReturnType<typeof setTimeout> {
      const id = ++seq;
      timers.set(id, fn);
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer(t: ReturnType<typeof setTimeout>) {
      timers.delete(t as unknown as number);
    },
    fireAll() {
      const fns = [...timers.values()];
      timers.clear();
      for (const fn of fns) fn();
    },
    pending(): number {
      return timers.size;
    },
  };
}

function supportedBackend() {
  const calls: string[] = [];
  const backend: InputLockBackend = {
    supported: true,
    async lock() {
      calls.push("lock");
    },
    async unlock() {
      calls.push("unlock");
    },
  };
  return { calls, backend };
}

test("lock() then unlock() drives the backend and state", async () => {
  const clock = fakeClock();
  const { calls, backend } = supportedBackend();
  const changes: boolean[] = [];
  const mgr = new InputLockManager({
    backend,
    autoReleaseMs: 1000,
    onChange: (l) => changes.push(l),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  await mgr.lock();
  assert.equal(mgr.isLocked, true);
  await mgr.unlock();
  assert.equal(mgr.isLocked, false);
  assert.deepEqual(calls, ["lock", "unlock"]);
  assert.deepEqual(changes, [true, false]);
});

test("unsupported backend never locks", async () => {
  const mgr = new InputLockManager({
    backend: { supported: false, async lock() {}, async unlock() {} },
    autoReleaseMs: 1000,
    onChange: () => {},
  });
  await mgr.lock();
  assert.equal(mgr.isLocked, false);
  assert.equal(mgr.supported, false);
});

test("watchdog auto-releases the lock when it fires", async () => {
  const clock = fakeClock();
  const { backend } = supportedBackend();
  const mgr = new InputLockManager({
    backend,
    autoReleaseMs: 1000,
    onChange: () => {},
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  await mgr.lock();
  assert.equal(mgr.isLocked, true);
  clock.fireAll(); // simulate the auto-release timeout elapsing
  await Promise.resolve(); // let the async unlock settle
  assert.equal(mgr.isLocked, false);
});

test("client activity keeps only one pending watchdog (resets, not stacks)", async () => {
  const clock = fakeClock();
  const { backend } = supportedBackend();
  const mgr = new InputLockManager({
    backend,
    autoReleaseMs: 1000,
    onChange: () => {},
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  await mgr.lock();
  mgr.noteClientActivity();
  mgr.noteClientActivity();
  assert.equal(clock.pending(), 1); // old timer cleared each time
});

test("noteClientActivity does nothing when unlocked", () => {
  const clock = fakeClock();
  const { backend } = supportedBackend();
  const mgr = new InputLockManager({
    backend,
    autoReleaseMs: 1000,
    onChange: () => {},
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  mgr.noteClientActivity();
  assert.equal(clock.pending(), 0);
});

test("toggle flips between locked and unlocked", async () => {
  const clock = fakeClock();
  const { backend } = supportedBackend();
  const mgr = new InputLockManager({
    backend,
    autoReleaseMs: 1000,
    onChange: () => {},
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  await mgr.toggle();
  assert.equal(mgr.isLocked, true);
  await mgr.toggle();
  assert.equal(mgr.isLocked, false);
});
