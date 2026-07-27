import { test } from "node:test";
import assert from "node:assert/strict";
import { clampLevel, detectVolumeController, UnsupportedVolumeController } from "./volume.js";

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

test("detection returns a controller matching this platform", async () => {
  const c = await detectVolumeController();
  if (process.platform === "darwin") {
    assert.equal(c.supported, true, "macOS has osascript");
  } else if (process.platform === "win32") {
    assert.equal(c.supported, false, "no base-install volume CLI on Windows");
  }
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
