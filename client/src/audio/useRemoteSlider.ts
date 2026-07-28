import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Drives a slider whose real value lives on the other end of a network.
 *
 * ## The problem this exists to solve
 *
 * Binding the input straight to the remote value looks correct and behaves
 * badly. Every render puts the *remote* number back into the control, so while
 * a drag is in flight the handle snaps back to where the machine still is —
 * measured on this app's volume slider: across a twenty-step drag the handle
 * showed the starting value on every single step, and the drag ended on the
 * wrong number because replies arrived in an order nobody promised.
 *
 * So the local value wins while the user is interacting, and the remote value
 * wins the rest of the time. That is the whole idea; the rest is deciding when
 * the handover happens.
 *
 * ## Why the handover is not just "on release"
 *
 * A slider can also be changed by the keyboard, by a click on the track, or by
 * someone standing at the remote machine turning the knob. Waiting for a
 * pointer release would strand the local value forever in the first two cases,
 * and ignore the third. Instead the local value is held until the remote one
 * agrees with what was last sent — the machine confirming it got there — or
 * until a quiet period passes with no interaction, whichever comes first.
 *
 * The quiet period matters because agreement may never arrive: the OS quantises
 * volume, so asking for 63 can settle at 62 and the two would disagree forever.
 *
 * ## Why sends are throttled
 *
 * A dragged slider fires a change per pixel of travel. Applying one on the
 * agent costs a process spawn — around a quarter of a second on macOS — so
 * sending all of them buries the machine in work that is obsolete on arrival.
 * Only positions far enough apart in time are sent, and the final position is
 * always sent, because the value the user releases on is the one that matters.
 */
export interface UseRemoteSlider {
  /** What the control should display right now. */
  value: number;
  /** Call from the input's onChange. */
  onChange: (value: number) => void;
}

/** Minimum gap between outgoing updates while dragging. */
const SEND_INTERVAL_MS = 60;
/** Idle time after the last interaction before the remote value takes over. */
const SETTLE_MS = 900;

export function useRemoteSlider(
  /** The value last reported by the remote end. */
  remoteValue: number,
  /** Sends a value; called at most every SEND_INTERVAL_MS, plus a final one. */
  send: (value: number) => void,
): UseRemoteSlider {
  /** Non-null while the user's value is the one being shown. */
  const [localValue, setLocalValue] = useState<number | null>(null);

  const sendRef = useRef(send);
  sendRef.current = send;
  const lastSentAtRef = useRef(0);
  const lastSentValueRef = useRef<number | null>(null);
  const trailingRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settleRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimers = () => {
    if (trailingRef.current) clearTimeout(trailingRef.current);
    if (settleRef.current) clearTimeout(settleRef.current);
    trailingRef.current = null;
    settleRef.current = null;
  };

  useEffect(() => clearTimers, []);

  // The remote end agreed with the last value sent, so it is no longer stale
  // and the local override can be dropped.
  useEffect(() => {
    if (localValue !== null && remoteValue === lastSentValueRef.current) {
      setLocalValue(null);
    }
  }, [remoteValue, localValue]);

  const onChange = useCallback((next: number) => {
    setLocalValue(next);

    const now = performance.now();
    const dispatch = (v: number) => {
      lastSentAtRef.current = performance.now();
      lastSentValueRef.current = v;
      sendRef.current(v);
    };

    if (trailingRef.current) clearTimeout(trailingRef.current);
    if (now - lastSentAtRef.current >= SEND_INTERVAL_MS) {
      dispatch(next);
    } else {
      // Too soon: hold this position and send it if nothing newer arrives, so
      // the last thing the user did is never the thing that gets dropped.
      trailingRef.current = setTimeout(
        () => dispatch(next),
        SEND_INTERVAL_MS - (now - lastSentAtRef.current),
      );
    }

    // Hand back to the remote value once the user has stopped, even if the two
    // never come to agree — the OS may quantise to a nearby step.
    if (settleRef.current) clearTimeout(settleRef.current);
    settleRef.current = setTimeout(() => setLocalValue(null), SETTLE_MS);
  }, []);

  return { value: localValue ?? remoteValue, onChange };
}
