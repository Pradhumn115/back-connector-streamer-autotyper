import type { ClientMessage } from "@bcsa/shared";

/**
 * Recognizes touch gestures and turns them into remote mouse input.
 *
 * ## Why this is a plain class rather than part of the hook
 *
 * The gesture rules are the part with real behaviour — what counts as a tap
 * versus a drag, when a hold becomes a right click, how two fingers become
 * wheel deltas — and all of it is decided from numbers, not from the DOM. Kept
 * inside a `useEffect` it would be reachable only through synthesized
 * TouchEvents in a headless browser; extracted, it is ordinary code with
 * ordinary tests, and the hook shrinks to event plumbing.
 *
 * Time is passed in rather than read from the clock for the same reason: a
 * long press is a rule about elapsed milliseconds, and a test should be able to
 * state the elapsed milliseconds instead of sleeping for them.
 *
 * ## The gesture set, and why these
 *
 * Modelled on a laptop trackpad rather than a touchscreen, because the thing
 * being driven is a desktop:
 *
 *  - one finger positions the cursor absolutely (the remote screen is visible
 *    and small, so pointing beats relative motion)
 *  - tap = left click
 *  - long press = right click, the only sane home for a second button
 *  - two fingers = scroll wheel
 *  - double-tap-and-hold, then move = drag with the button held, which is the
 *    trackpad convention and the only route to drag-and-drop
 */

/** A touch position in normalized 0..1 frame coordinates. */
export interface Point {
  x: number;
  y: number;
}

/** One finger, in both coordinate spaces the rules need. */
export interface TouchPoint {
  /** Normalized position within the frame, for messages sent to the agent. */
  point: Point;
  /** Raw CSS pixels, for distance thresholds that must not scale with zoom. */
  clientX: number;
  clientY: number;
}

/** Movement beyond this many CSS px means "drag", not "tap". */
export const TAP_SLOP_PX = 10;
/** Hold longer than this without moving and it becomes a right click. */
export const LONG_PRESS_MS = 500;
/** A second tap within this window starts a held drag. */
export const DOUBLE_TAP_MS = 300;
/** Throttle for move messages, matching the mouse path. */
export const MOVE_INTERVAL_MS = 20;
/**
 * Two-finger movement is multiplied by this to become wheel deltas.
 *
 * A wheel "line" is roughly 40px on most platforms, so scrolling would feel
 * glacial if finger pixels became wheel pixels one for one.
 */
export const SCROLL_SCALE = 2;

type Send = (msg: ClientMessage) => void;

export class TouchGestures {
  private startX = 0;
  private startY = 0;
  private startPoint: Point = { x: 0, y: 0 };
  private startedAt = 0;
  private moved = false;
  /** Set once a long press fired, so the release does not also click. */
  private longPressed = false;
  /** True while the left button is held for a drag gesture. */
  private dragging = false;
  private scrolling = false;
  private scrollX = 0;
  private scrollY = 0;
  private lastTapEndedAt = Number.NEGATIVE_INFINITY;
  private lastMoveAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly send: Send,
    /** Called on a tap, to raise the on-screen keyboard. */
    private readonly onTap: () => void = () => {},
  ) {}

  /** True while a hold could still become a right click; the hook polls this. */
  get awaitingLongPress(): boolean {
    return !this.moved && !this.longPressed && !this.dragging && !this.scrolling;
  }

  start(touches: TouchPoint[], now: number): void {
    if (touches.length >= 2) {
      // A second finger abandons whatever single-finger gesture was forming.
      this.scrolling = true;
      this.moved = true;
      this.scrollX = (touches[0]!.clientX + touches[1]!.clientX) / 2;
      this.scrollY = (touches[0]!.clientY + touches[1]!.clientY) / 2;
      return;
    }
    const t = touches[0];
    if (!t) return;

    this.startX = t.clientX;
    this.startY = t.clientY;
    this.startPoint = t.point;
    this.startedAt = now;
    this.moved = false;
    this.longPressed = false;
    this.scrolling = false;

    // Put the cursor under the finger before any button is pressed, so a click
    // lands where the user is looking even if this becomes a drag.
    this.send({ type: "mouse", action: "move", ...t.point });

    // A tap close behind another tap is the start of a held drag.
    if (now - this.lastTapEndedAt < DOUBLE_TAP_MS) {
      this.dragging = true;
      this.send({ type: "mouse", action: "down", ...t.point, button: "left" });
    }
  }

  move(touches: TouchPoint[], now: number): void {
    if (this.scrolling && touches.length >= 2) {
      const cx = (touches[0]!.clientX + touches[1]!.clientX) / 2;
      const cy = (touches[0]!.clientY + touches[1]!.clientY) / 2;
      // Inverted: dragging fingers up scrolls content down, as touch scrolling
      // behaves everywhere else.
      this.send({
        type: "mouse",
        action: "scroll",
        dx: (this.scrollX - cx) * SCROLL_SCALE,
        dy: (this.scrollY - cy) * SCROLL_SCALE,
      });
      this.scrollX = cx;
      this.scrollY = cy;
      return;
    }

    const t = touches[0];
    if (!t) return;
    if (
      Math.abs(t.clientX - this.startX) > TAP_SLOP_PX ||
      Math.abs(t.clientY - this.startY) > TAP_SLOP_PX
    ) {
      this.moved = true;
    }

    if (now - this.lastMoveAt < MOVE_INTERVAL_MS) return;
    this.lastMoveAt = now;
    this.send({ type: "mouse", action: "move", ...t.point });
  }

  /**
   * Fires the right click once a hold has lasted long enough. Called on a
   * timer by the hook; returns true if the long press fired.
   */
  tick(now: number): boolean {
    if (!this.awaitingLongPress) return false;
    if (now - this.startedAt < LONG_PRESS_MS) return false;
    this.longPressed = true;
    this.send({ type: "mouse", action: "down", ...this.startPoint, button: "right" });
    this.send({ type: "mouse", action: "up", ...this.startPoint, button: "right" });
    return true;
  }

  /** @param remaining fingers still touching after this release. */
  end(released: TouchPoint | undefined, remaining: number, now: number): void {
    const point = released?.point ?? this.startPoint;

    if (this.dragging) {
      this.send({ type: "mouse", action: "up", ...point, button: "left" });
      this.dragging = false;
      // Not a tap, so it must not chain into another drag.
      this.lastTapEndedAt = Number.NEGATIVE_INFINITY;
      return;
    }

    if (this.scrolling) {
      // A partial release is not a tap; wait for every finger to lift.
      if (remaining === 0) this.scrolling = false;
      return;
    }

    if (!this.moved && !this.longPressed && now - this.startedAt < LONG_PRESS_MS) {
      this.send({ type: "mouse", action: "down", ...point, button: "left" });
      this.send({ type: "mouse", action: "up", ...point, button: "left" });
      this.lastTapEndedAt = now;
      this.onTap();
    }
  }

  /** The gesture was interrupted; release anything still held. */
  cancel(): void {
    if (this.dragging) {
      this.send({ type: "mouse", action: "up", ...this.startPoint, button: "left" });
    }
    this.dragging = false;
    this.scrolling = false;
    this.moved = true;
  }
}
