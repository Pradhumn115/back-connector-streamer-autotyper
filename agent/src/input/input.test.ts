import { test } from "node:test";
import assert from "node:assert/strict";
import { toPixel } from "./coords.js";
import { InputController, type InputBackend, type ScreenSize } from "./index.js";

test("toPixel maps normalized coords to pixel range", () => {
  assert.equal(toPixel(0, 1920), 0);
  assert.equal(toPixel(1, 1920), 1919);
  assert.equal(toPixel(0.5, 1000), 500); // round(0.5 * 999) = 500
});

test("toPixel clamps out-of-range input", () => {
  assert.equal(toPixel(-0.5, 1000), 0);
  assert.equal(toPixel(2, 1000), 999);
});

function fakeBackend(size: ScreenSize) {
  const calls: string[] = [];
  const backend: InputBackend = {
    async screenSize() {
      calls.push("screenSize");
      return size;
    },
    async moveMouse(x, y) {
      calls.push(`move(${x},${y})`);
    },
    async mouseButton(action, button) {
      calls.push(`button(${action},${button})`);
    },
    async scroll(dx, dy) {
      calls.push(`scroll(${dx},${dy})`);
    },
    async keyAction(action, key, mods) {
      calls.push(`key(${action},${key},[${mods.join("+")}])`);
    },
  };
  return { calls, backend };
}

test("applyMouse moves then presses using translated coords", async () => {
  const { calls, backend } = fakeBackend({ width: 800, height: 600 });
  const ctrl = new InputController(backend);
  await ctrl.applyMouse({ type: "mouse", action: "click", x: 0.5, y: 0.5, button: "left" });
  assert.deepEqual(calls, ["screenSize", "move(400,300)", "button(click,left)"]);
});

test("applyMouse move does not press a button", async () => {
  const { calls, backend } = fakeBackend({ width: 100, height: 100 });
  const ctrl = new InputController(backend);
  await ctrl.applyMouse({ type: "mouse", action: "move", x: 1, y: 0 });
  assert.deepEqual(calls, ["screenSize", "move(99,0)"]);
});

test("applyMouse scroll bypasses coordinate translation", async () => {
  const { calls, backend } = fakeBackend({ width: 100, height: 100 });
  const ctrl = new InputController(backend);
  await ctrl.applyMouse({ type: "mouse", action: "scroll", dx: 0, dy: 3 });
  assert.deepEqual(calls, ["scroll(0,3)"]);
});

test("screen size is cached after first lookup", async () => {
  const { calls, backend } = fakeBackend({ width: 100, height: 100 });
  const ctrl = new InputController(backend);
  await ctrl.screenSize();
  await ctrl.screenSize();
  assert.equal(calls.filter((c) => c === "screenSize").length, 1);
});

test("applyKey forwards action, key and modifiers", async () => {
  const { calls, backend } = fakeBackend({ width: 100, height: 100 });
  const ctrl = new InputController(backend);
  await ctrl.applyKey({ type: "key", action: "press", key: "c", modifiers: ["ctrl"] });
  assert.deepEqual(calls, ["key(press,c,[ctrl])"]);
});
