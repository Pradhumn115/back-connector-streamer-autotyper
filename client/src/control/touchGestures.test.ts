import { test } from "node:test";
import assert from "node:assert/strict";
import type { ClientMessage } from "@bcsa/shared";
import {
  DOUBLE_TAP_MS,
  LONG_PRESS_MS,
  MOVE_INTERVAL_MS,
  SCROLL_SCALE,
  TAP_SLOP_PX,
  TouchGestures,
  type TouchPoint,
} from "./touchGestures.js";

/** A finger at raw pixel (cx, cy); the normalized point is derived so the two
 *  spaces stay distinguishable in assertions. */
function finger(cx: number, cy: number): TouchPoint {
  return { clientX: cx, clientY: cy, point: { x: cx / 1000, y: cy / 1000 } };
}

function recorder() {
  const sent: ClientMessage[] = [];
  const taps: number[] = [];
  const g = new TouchGestures(
    (m) => sent.push(m),
    () => taps.push(1),
  );
  return { g, sent, taps };
}

/** Just the button actions, which is what most rules are about. */
const buttons = (sent: ClientMessage[]) =>
  sent
    .filter((m) => m.type === "mouse" && (m.action === "down" || m.action === "up"))
    .map((m) => `${(m as { action: string }).action}:${(m as { button?: string }).button}`);

test("a tap sends a left press and release at the touch point", () => {
  const { g, sent } = recorder();
  g.start([finger(100, 200)], 0);
  g.end(finger(100, 200), 0, 50);

  assert.deepEqual(buttons(sent), ["down:left", "up:left"]);
  // The cursor is positioned before the button is pressed, in normalized space.
  assert.deepEqual(sent[0], { type: "mouse", action: "move", x: 0.1, y: 0.2 });
});

test("a tap raises the on-screen keyboard, a drag does not", () => {
  const tapped = recorder();
  tapped.g.start([finger(10, 10)], 0);
  tapped.g.end(finger(10, 10), 0, 40);
  assert.equal(tapped.taps.length, 1);

  const dragged = recorder();
  dragged.g.start([finger(10, 10)], 0);
  dragged.g.move([finger(10 + TAP_SLOP_PX + 5, 10)], 30);
  dragged.g.end(finger(10 + TAP_SLOP_PX + 5, 10), 0, 60);
  assert.equal(dragged.taps.length, 0, "a drag is not a tap");
});

test("moving past the slop threshold suppresses the click", () => {
  const { g, sent } = recorder();
  g.start([finger(100, 100)], 0);
  g.move([finger(100 + TAP_SLOP_PX + 1, 100)], 30);
  g.end(finger(100 + TAP_SLOP_PX + 1, 100), 0, 60);

  assert.deepEqual(buttons(sent), [], "a drag must not click");
});

test("movement within the slop threshold is still a click", () => {
  const { g, sent } = recorder();
  g.start([finger(100, 100)], 0);
  g.move([finger(100 + TAP_SLOP_PX - 1, 100)], 30);
  g.end(finger(100 + TAP_SLOP_PX - 1, 100), 0, 60);

  assert.deepEqual(buttons(sent), ["down:left", "up:left"], "a shaky finger still taps");
});

test("holding still past the threshold right-clicks, and the release does not also click", () => {
  const { g, sent } = recorder();
  g.start([finger(50, 60)], 0);

  assert.equal(g.tick(LONG_PRESS_MS - 1), false, "not yet");
  assert.deepEqual(buttons(sent), []);

  assert.equal(g.tick(LONG_PRESS_MS), true);
  assert.deepEqual(buttons(sent), ["down:right", "up:right"]);

  g.end(finger(50, 60), 0, LONG_PRESS_MS + 100);
  assert.deepEqual(
    buttons(sent),
    ["down:right", "up:right"],
    "lifting after a long press must not add a left click",
  );
});

test("a long press fires once, however often it is polled", () => {
  const { g, sent } = recorder();
  g.start([finger(50, 60)], 0);

  assert.equal(g.tick(LONG_PRESS_MS), true);
  assert.equal(g.tick(LONG_PRESS_MS + 50), false, "already fired");
  assert.equal(g.tick(LONG_PRESS_MS + 900), false);

  assert.deepEqual(
    buttons(sent),
    ["down:right", "up:right"],
    "a held finger must not repeat the right click",
  );
});

test("a finger that moved cannot become a long press", () => {
  const { g, sent } = recorder();
  g.start([finger(50, 60)], 0);
  g.move([finger(50 + TAP_SLOP_PX + 5, 60)], 100);

  assert.equal(g.tick(LONG_PRESS_MS + 10), false);
  assert.deepEqual(buttons(sent), []);
});

test("double-tap-and-hold holds the button down and releases it on lift", () => {
  const { g, sent } = recorder();
  g.start([finger(20, 20)], 0);
  g.end(finger(20, 20), 0, 40); // first tap

  const second = 40 + DOUBLE_TAP_MS - 10;
  g.start([finger(20, 20)], second);
  // The button goes down on touch, before any movement — that is what makes a
  // drag possible.
  assert.deepEqual(buttons(sent).slice(2), ["down:left"]);

  g.move([finger(120, 220)], second + 30);
  g.end(finger(120, 220), 0, second + 60);
  assert.deepEqual(buttons(sent).slice(2), ["down:left", "up:left"]);

  // Released at the finger's final position, not where the drag began.
  const last = sent[sent.length - 1] as { x: number; y: number };
  assert.deepEqual({ x: last.x, y: last.y }, { x: 0.12, y: 0.22 });
});

test("a second tap arriving too late is an ordinary tap, not a drag", () => {
  const { g, sent } = recorder();
  g.start([finger(20, 20)], 0);
  g.end(finger(20, 20), 0, 40);

  const late = 40 + DOUBLE_TAP_MS + 1;
  g.start([finger(20, 20)], late);
  assert.deepEqual(buttons(sent).slice(2), [], "no button held on touch");
  g.end(finger(20, 20), 0, late + 30);
  assert.deepEqual(buttons(sent).slice(2), ["down:left", "up:left"]);
});

test("a drag does not chain into another drag", () => {
  const { g, sent } = recorder();
  g.start([finger(20, 20)], 0);
  g.end(finger(20, 20), 0, 30); // tap
  g.start([finger(20, 20)], 60); // becomes a drag
  g.end(finger(90, 90), 0, 200); // drag ends

  const next = 210;
  g.start([finger(20, 20)], next);
  assert.deepEqual(
    buttons(sent).slice(4),
    [],
    "the touch after a drag must not immediately hold the button",
  );
});

test("two fingers scroll by the centroid delta, inverted and scaled", () => {
  const { g, sent } = recorder();
  g.start([finger(100, 100), finger(200, 200)], 0); // centroid (150, 150)
  g.move([finger(100, 80), finger(200, 180)], 30); // centroid (150, 130)

  const scroll = sent.find((m) => m.type === "mouse" && m.action === "scroll") as {
    dx: number;
    dy: number;
  };
  // Fingers moved up 20px, so content scrolls down: positive dy.
  assert.deepEqual(scroll, {
    type: "mouse",
    action: "scroll",
    dx: 0,
    dy: 20 * SCROLL_SCALE,
  });
});

test("a two-finger gesture never clicks, even on the final release", () => {
  const { g, sent } = recorder();
  g.start([finger(100, 100), finger(200, 200)], 0);
  g.move([finger(100, 80), finger(200, 180)], 30);
  g.end(finger(100, 80), 1, 60); // one finger lifts
  g.end(finger(200, 180), 0, 70); // the other lifts

  assert.deepEqual(buttons(sent), [], "scrolling must not leave a click behind");
});

test("move messages are throttled", () => {
  const { g, sent } = recorder();
  g.start([finger(0, 0)], 0);
  const afterStart = sent.length;

  g.move([finger(1, 1)], 1000);
  g.move([finger(2, 2)], 1000 + MOVE_INTERVAL_MS - 1); // too soon
  g.move([finger(3, 3)], 1000 + MOVE_INTERVAL_MS); // allowed

  const moves = sent.slice(afterStart).filter((m) => m.type === "mouse" && m.action === "move");
  assert.equal(moves.length, 2);
});

test("cancelling mid-drag releases the held button", () => {
  const { g, sent } = recorder();
  g.start([finger(20, 20)], 0);
  g.end(finger(20, 20), 0, 30);
  g.start([finger(20, 20)], 60); // drag begins, button held
  assert.deepEqual(buttons(sent).slice(2), ["down:left"]);

  g.cancel();
  assert.deepEqual(
    buttons(sent).slice(2),
    ["down:left", "up:left"],
    "an interrupted drag must not leave the button stuck down",
  );
});
