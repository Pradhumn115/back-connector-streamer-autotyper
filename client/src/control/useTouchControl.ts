import { useEffect, useRef } from "react";
import type { ClientMessage } from "@bcsa/shared";
import type { ContentRect } from "../view/ScreenView";
import { normalizedCoords } from "./useRemoteControl";
import { LONG_PRESS_MS, TouchGestures, type TouchPoint } from "./touchGestures";

type SendFn = (msg: ClientMessage) => void;
type ControlSurface = HTMLCanvasElement | HTMLVideoElement;

/**
 * Binds touch events on the canvas to the gesture recognizer.
 *
 * ## Why touch needs handling at all, when taps already "work"
 *
 * A phone does deliver `mousedown`/`mouseup` after a tap — browsers synthesize
 * them for compatibility — so tapping appears to work without this. Everything
 * else does not: a drag scrolls the page rather than the remote cursor, there
 * is no second button, and there is no wheel. The synthesized events also
 * arrive only *after* the gesture completes, so a drag would teleport the
 * cursor instead of tracking the finger.
 *
 * `preventDefault` on touchstart is what suppresses those compatibility events.
 * Without it every tap would actuate twice: once here, once through
 * `useRemoteControl`.
 *
 * The rules themselves live in `touchGestures.ts`, which has no DOM dependency
 * and is tested directly.
 */
export function useTouchControl(
  canvasRef: React.RefObject<ControlSurface>,
  contentRectRef: React.MutableRefObject<ContentRect>,
  send: SendFn,
  enabled: boolean,
  /** Called on the tap that should raise the on-screen keyboard. */
  onRequestKeyboard?: () => void,
): void {
  const sendRef = useRef<SendFn>(send);
  const enabledRef = useRef<boolean>(enabled);
  const keyboardRef = useRef<(() => void) | undefined>(onRequestKeyboard);
  sendRef.current = send;
  enabledRef.current = enabled;
  keyboardRef.current = onRequestKeyboard;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const el = canvas as HTMLElement;

    const gestures = new TouchGestures(
      (msg) => sendRef.current(msg),
      () => keyboardRef.current?.(),
    );
    let longPressTimer: ReturnType<typeof setTimeout> | null = null;
    const clearLongPress = () => {
      if (longPressTimer !== null) clearTimeout(longPressTimer);
      longPressTimer = null;
    };

    /** Every touch, in both the normalized and raw spaces the rules need. */
    const points = (list: TouchList): TouchPoint[] =>
      Array.from(list).map((t) => ({
        point: normalizedCoords(canvas, contentRectRef.current, t.clientX, t.clientY),
        clientX: t.clientX,
        clientY: t.clientY,
      }));

    const onTouchStart = (e: TouchEvent) => {
      if (!enabledRef.current) return;
      e.preventDefault(); // Suppresses the double-actuating compat mouse events.
      gestures.start(points(e.touches), performance.now());
      clearLongPress();
      longPressTimer = setTimeout(() => {
        longPressTimer = null;
        if (enabledRef.current) gestures.tick(performance.now());
      }, LONG_PRESS_MS);
    };

    const onTouchMove = (e: TouchEvent) => {
      if (!enabledRef.current) return;
      e.preventDefault();
      gestures.move(points(e.touches), performance.now());
      // A moved finger can no longer become a long press.
      if (!gestures.awaitingLongPress) clearLongPress();
    };

    const onTouchEnd = (e: TouchEvent) => {
      if (!enabledRef.current) return;
      e.preventDefault();
      clearLongPress();
      const released = points(e.changedTouches)[0];
      gestures.end(released, e.touches.length, performance.now());
    };

    const onTouchCancel = () => {
      clearLongPress();
      gestures.cancel();
    };

    // Not passive: each of these calls preventDefault, and a passive listener
    // that does so is ignored with a console warning.
    const opts = { passive: false } as const;
    el.addEventListener("touchstart", onTouchStart, opts);
    el.addEventListener("touchmove", onTouchMove, opts);
    el.addEventListener("touchend", onTouchEnd, opts);
    el.addEventListener("touchcancel", onTouchCancel, opts);

    return () => {
      clearLongPress();
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchCancel);
    };
  }, [canvasRef, contentRectRef]);
}
