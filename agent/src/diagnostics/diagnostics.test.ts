import { test } from "node:test";
import assert from "node:assert/strict";
import { runDiagnostics } from "./index.js";

const base = {
  refreshHz: 60,
  inputLockSupported: true,
  audioSupported: true,
  screenSize: { width: 1920, height: 1080 } as { width: number; height: number } | null,
};

function byId(checks: ReturnType<typeof runDiagnostics>, id: string) {
  const c = checks.find((x) => x.id === id);
  assert.ok(c, `check ${id} missing`);
  return c!;
}

test("always reports the core set of checks", () => {
  const checks = runDiagnostics(base);
  for (const id of ["runtime", "ffmpeg", "capture-engine", "screen-access", "input-lock", "audio-loopback"]) {
    byId(checks, id);
  }
});

test("null screen size is a failure with a fix", () => {
  const c = byId(runDiagnostics({ ...base, screenSize: null }), "screen-access");
  assert.equal(c.status, "fail");
  assert.ok(c.fix && c.fix.length > 0);
});

test("missing audio loopback warns with a per-OS fix", () => {
  const c = byId(runDiagnostics({ ...base, audioSupported: false }), "audio-loopback");
  assert.equal(c.status, "warn");
  assert.match(c.fix ?? "", /BlackHole|VB-Cable|PulseAudio|PipeWire/);
});

test("unsupported input lock warns rather than failing", () => {
  const c = byId(runDiagnostics({ ...base, inputLockSupported: false }), "input-lock");
  assert.equal(c.status, "warn");
});

test("every non-ok check carries a fix string", () => {
  const checks = runDiagnostics({ ...base, screenSize: null, audioSupported: false });
  for (const c of checks) {
    if (c.status !== "ok") assert.ok(c.fix, `${c.id} is ${c.status} but has no fix`);
  }
});
