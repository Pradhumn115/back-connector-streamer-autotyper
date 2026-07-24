import { test } from "node:test";
import assert from "node:assert/strict";
import { decideElevation } from "./elevation.js";

test("non-Windows is always treated as elevated (no warning)", () => {
  assert.equal(decideElevation({ platform: "darwin", status: 1, error: false }), true);
  assert.equal(decideElevation({ platform: "linux", status: null, error: true }), true);
});

test("Windows: `net session` exit 0 means elevated", () => {
  assert.equal(decideElevation({ platform: "win32", status: 0, error: false }), true);
});

test("Windows: non-zero exit means not elevated", () => {
  assert.equal(decideElevation({ platform: "win32", status: 2, error: false }), false);
  assert.equal(decideElevation({ platform: "win32", status: null, error: false }), false);
});

test("Windows: probe error is treated as elevated to avoid a spurious warning", () => {
  assert.equal(decideElevation({ platform: "win32", status: null, error: true }), true);
});
