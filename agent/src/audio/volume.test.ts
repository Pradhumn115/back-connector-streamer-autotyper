import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clampLevel,
  detectVolumeController,
  UnsupportedVolumeController,
  WindowsVolumeController,
} from "./volume.js";

test("clampLevel keeps levels inside the wire range", () => {
  assert.equal(clampLevel(50), 50);
  assert.equal(clampLevel(0), 0);
  assert.equal(clampLevel(100), 100);
  assert.equal(clampLevel(-20), 0);
  assert.equal(clampLevel(180), 100);
});

test("clampLevel rounds, because no OS takes a fractional level", () => {
  assert.equal(clampLevel(42.4), 42);
  assert.equal(clampLevel(42.6), 43);
});

test("clampLevel turns non-numbers into silence rather than passing them on", () => {
  // These would reach the OS command as text if they survived. They cannot
  // (arguments go through execFile as an array, never a shell string), but a
  // level that is not a number must still not become one.
  assert.equal(clampLevel(NaN), 0);
  assert.equal(clampLevel(Infinity), 100);
  assert.equal(clampLevel(-Infinity), 0);
});

test("an unsupported controller reports so and does nothing", async () => {
  const c = new UnsupportedVolumeController();
  assert.equal(c.supported, false);
  assert.equal(await c.get(), null);
  // Must not throw: the caller reports state either way.
  await c.setLevel(50);
  await c.setMuted(true);
});

// --- Windows helper protocol ------------------------------------------------
// The Windows path cannot run here, but its wire protocol can: commands are
// written a line at a time and replies are paired to them in order. That
// pairing is the part that breaks quietly — a dropped or late reply shifts
// every subsequent answer onto the wrong command, so the volume would report
// the mute flag and vice versa.

/** Stands in for the PowerShell helper, with a scripted set of replies. */
function fakeHelper(replies: Record<string, string>) {
  const written: string[] = [];
  let onData: ((chunk: string) => void) | undefined;
  let onExit: (() => void) | undefined;
  const proc = {
    stdin: {
      write(chunk: string) {
        written.push(chunk.trim());
        const reply = replies[chunk.trim()];
        // Asynchronous, as a real process would be.
        if (reply !== undefined) queueMicrotask(() => onData?.(`${reply}\n`));
        return true;
      },
      end() {},
    },
    stdout: {
      setEncoding() {},
      on(_ev: "data", cb: (chunk: string) => void) {
        onData = cb;
      },
    },
    on(_ev: "exit", cb: () => void) {
      onExit = cb;
    },
    kill() {},
  };
  return {
    proc,
    written,
    exit: () => onExit?.(),
    /** Push raw bytes to the reader, to model how a pipe actually chunks. */
    emit: (raw: string) => onData?.(raw),
  };
}

test("windows helper parses a get reply into level and mute", async () => {
  const { proc, written } = fakeHelper({ get: "42,true" });
  const c = new WindowsVolumeController(proc);
  assert.deepEqual(await c.get(), { level: 42, muted: true });
  assert.deepEqual(written, ["get"]);
});

test("windows helper clamps the level it sends, never passing the raw number", async () => {
  const { proc, written } = fakeHelper({ "set 100": "ok", "set 0": "ok", "set 50": "ok" });
  const c = new WindowsVolumeController(proc);
  await c.setLevel(999);
  await c.setLevel(-5);
  await c.setLevel(50.4);
  assert.deepEqual(written, ["set 100", "set 0", "set 50"]);
});

test("windows helper sends mute as an explicit state, not a toggle", async () => {
  const { proc, written } = fakeHelper({ "mute 1": "ok", "mute 0": "ok" });
  const c = new WindowsVolumeController(proc);
  await c.setMuted(true);
  await c.setMuted(false);
  // A toggle could not be driven from a checkbox without the agent tracking
  // state it cannot see changing.
  assert.deepEqual(written, ["mute 1", "mute 0"]);
});

test("windows helper pairs replies to commands in order", async () => {
  const { proc } = fakeHelper({ get: "10,false", "mute 1": "ok" });
  const c = new WindowsVolumeController(proc);
  // Both in flight at once: the get must not receive the mute's "ok".
  const [got] = await Promise.all([c.get(), c.setMuted(true)]);
  assert.deepEqual(got, { level: 10, muted: false });
});

test("windows helper splits two replies delivered in one chunk", async () => {
  const { proc, emit } = fakeHelper({}); // no scripted replies; fed manually
  const c = new WindowsVolumeController(proc);
  const pending = Promise.all([c.get(), c.get()]);
  // A pipe is free to coalesce writes; both replies must still be paired.
  emit("70,false\n80,true\n");
  const [a, b] = await pending;
  assert.deepEqual(a, { level: 70, muted: false });
  assert.deepEqual(b, { level: 80, muted: true });
});

test("windows helper waits for a reply split across chunks", async () => {
  const { proc, emit } = fakeHelper({});
  const c = new WindowsVolumeController(proc);
  const pending = c.get();
  // Arriving a few bytes at a time must not be read as a complete line.
  emit("3");
  emit("5,tr");
  emit("ue\n");
  assert.deepEqual(await pending, { level: 35, muted: true });
});

test("windows helper fails outstanding commands when the process exits", async () => {
  const { proc, exit } = fakeHelper({});
  const c = new WindowsVolumeController(proc);
  const pending = c.get();
  exit();
  // Must resolve rather than hang: a caller awaiting this forever would stall
  // the diagnostics panel and every later volume change.
  assert.equal(await pending, null);
});

test("detection returns a controller matching this platform", async () => {
  const c = await detectVolumeController();
  if (process.platform === "darwin") {
    assert.equal(c.supported, true, "macOS has osascript");
  }
  // Windows is deliberately not asserted either way: support there depends on
  // whether PowerShell could compile the helper, which a locked-down machine
  // may refuse. The startup probe decides it, so a fixed expectation here would
  // be asserting something this process cannot know.
  // Whatever it is, the interface is complete.
  assert.equal(typeof c.get, "function");
  assert.equal(typeof c.setLevel, "function");
  assert.equal(typeof c.setMuted, "function");
});

test("macOS reports the mute flag, not just the level", async (t) => {
  if (process.platform !== "darwin") return t.skip("macOS only");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);

  // Regression: `&` on a number builds a LIST in AppleScript rather than
  // concatenating, so the unquoted form prints "25, ,, true" and the mute flag
  // lands in the wrong field. The level still parsed, which is exactly what
  // made a broken mute look like a working control.
  const { stdout } = await run("osascript", [
    "-e",
    "(output volume of (get volume settings) as text) & \",\" &" +
      " (output muted of (get volume settings) as text)",
  ]);
  const parts = stdout.trim().split(",");
  assert.equal(parts.length, 2, `expected "level,muted", got ${JSON.stringify(stdout.trim())}`);
  assert.ok(Number.isFinite(Number(parts[0])), "first field is the level");
  assert.match(parts[1].trim(), /^(true|false)$/, "second field is the mute flag");
});

test("on a supported platform, the level read back is a valid percentage", async (t) => {
  const c = await detectVolumeController();
  if (!c.supported) return t.skip("no volume control on this platform");
  const current = await c.get();
  if (!current) return t.skip("could not read the current volume");
  assert.ok(
    Number.isInteger(current.level) && current.level >= 0 && current.level <= 100,
    `level ${current.level} is not a percentage`,
  );
  assert.equal(typeof current.muted, "boolean");
});
