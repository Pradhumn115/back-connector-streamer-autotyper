import { useEffect, useRef } from "react";
import type { ClientMessage } from "@bcsa/shared";
import type { ContentRect } from "../view/ScreenView";
import { mapPointerToNormalized } from "./mapCoords";

type Modifier = "ctrl" | "alt" | "shift" | "meta";
type SendFn = (msg: ClientMessage) => void;
type ControlSurface = HTMLCanvasElement | HTMLVideoElement;

// Throttle mousemove to ~50/s to avoid flooding the socket.
const MOVE_INTERVAL_MS = 20;

/**
 * Delay after forwarding Ctrl/Cmd+C or +X before fetching the agent's
 * clipboard. The OS needs a moment to actually populate its clipboard after
 * the keypress lands — this is a real OS-level delay, not network latency,
 * so it's needed even on an instant local connection.
 */
const CLIPBOARD_COPY_FETCH_DELAY_MS = 200;

/**
 * Delay between sending setClipboard and forwarding Ctrl/Cmd+V's own
 * keystroke, so the agent applies the new clipboard content before the
 * paste happens.
 *
 * Not relying on the two messages' send order alone: the agent dispatches
 * each incoming message via a fire-and-forget call (see onControlMessage's
 * call site), not one awaited before the next is handled, so two native
 * calls (clipboard set vs. key press) racing on the agent's side could
 * finish in either order with no gap at all between the sends.
 */
const CLIPBOARD_PASTE_DELAY_MS = 150;

const buttonName = (button: number): "left" | "middle" | "right" => {
  switch (button) {
    case 1:
      return "middle";
    case 2:
      return "right";
    default:
      return "left";
  }
};

function collectModifiers(e: KeyboardEvent): Modifier[] {
  const mods: Modifier[] = [];
  if (e.ctrlKey) mods.push("ctrl");
  if (e.altKey) mods.push("alt");
  if (e.shiftKey) mods.push("shift");
  if (e.metaKey) mods.push("meta");
  return mods;
}

/**
 * Convert a mouse event position into normalized 0..1 coordinates relative to
 * the *frame image* inside the canvas. The frame is letterboxed (centered, with
 * black bars), so we map against the actual image rectangle published by
 * ScreenView — not the whole canvas — otherwise clicks are offset and mis-scaled
 * whenever the screen's aspect ratio differs from the canvas's.
 */
export function normalizedCoords(
  canvas: ControlSurface,
  content: ContentRect,
  clientX: number,
  clientY: number,
): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  return mapPointerToNormalized(clientX, clientY, rect, backingStoreOf(canvas, rect), content);
}

/**
 * The surface's pixel dimensions, falling back to its CSS box.
 *
 * Duck-typed rather than `instanceof HTMLCanvasElement`, which would throw a
 * ReferenceError anywhere the DOM globals are absent.
 */
function backingStoreOf(
  surface: ControlSurface,
  rect: DOMRect,
): { width: number; height: number } {
  const { width, height } = surface as { width?: number; height?: number };
  if (typeof width === "number" && typeof height === "number" && width > 0 && height > 0) {
    return { width, height };
  }
  return { width: rect.width, height: rect.height };
}

/**
 * Attaches mouse + keyboard handlers to a canvas element and translates them
 * into ClientMessages. `enabled` gates all input so the user can release
 * control. Keyboard events are captured only while the canvas is focused.
 */
export function useRemoteControl(
  canvasRef: React.RefObject<ControlSurface>,
  contentRectRef: React.MutableRefObject<ContentRect>,
  send: SendFn,
  enabled: boolean,
  getClipboard: () => void,
  setClipboard: () => Promise<void>,
): void {
  // Keep the latest send/enabled in refs so listeners stay stable.
  const sendRef = useRef<SendFn>(send);
  const enabledRef = useRef<boolean>(enabled);
  const lastMoveRef = useRef<number>(0);
  const getClipboardRef = useRef(getClipboard);
  const setClipboardRef = useRef(setClipboard);

  useEffect(() => {
    sendRef.current = send;
  }, [send]);
  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);
  useEffect(() => {
    getClipboardRef.current = getClipboard;
  }, [getClipboard]);
  useEffect(() => {
    setClipboardRef.current = setClipboard;
  }, [setClipboard]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const onMouseMove = (e: MouseEvent) => {
      if (!enabledRef.current) return;
      const now = performance.now();
      if (now - lastMoveRef.current < MOVE_INTERVAL_MS) return;
      lastMoveRef.current = now;
      const { x, y } = normalizedCoords(canvas, contentRectRef.current, e.clientX, e.clientY);
      sendRef.current({ type: "mouse", action: "move", x, y });
    };

    const onMouseDown = (e: MouseEvent) => {
      if (!enabledRef.current) return;
      canvas.focus();
      const { x, y } = normalizedCoords(canvas, contentRectRef.current, e.clientX, e.clientY);
      sendRef.current({
        type: "mouse",
        action: "down",
        x,
        y,
        button: buttonName(e.button),
      });
    };

    const onMouseUp = (e: MouseEvent) => {
      if (!enabledRef.current) return;
      const { x, y } = normalizedCoords(canvas, contentRectRef.current, e.clientX, e.clientY);
      sendRef.current({
        type: "mouse",
        action: "up",
        x,
        y,
        button: buttonName(e.button),
      });
    };

    // We forward only raw down/up/move (the RFB/VNC model): the agent OS turns
    // press+release into a click, rapid press/release/press/release into a
    // double-click, and press+move+release into a drag. We deliberately do NOT
    // also send the browser's synthesized `click`/`dblclick`/`contextmenu`
    // events — doing so would actuate every button a second time (a single
    // click would fire twice, a right-click would open the menu twice, etc.).

    const onContextMenu = (e: MouseEvent) => {
      if (!enabledRef.current) return;
      // Only stop the browser's own context menu; the right-button down/up
      // already sent via onMouseDown/onMouseUp produces the remote right-click.
      e.preventDefault();
    };

    const onWheel = (e: WheelEvent) => {
      if (!enabledRef.current) return;
      e.preventDefault();
      sendRef.current({
        type: "mouse",
        action: "scroll",
        dx: e.deltaX,
        dy: e.deltaY,
      });
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (!enabledRef.current) return;
      // Stop browser shortcuts (Cmd/Ctrl+key, Tab, etc.) while focused.
      e.preventDefault();
      const modifiers = collectModifiers(e);
      const key = e.key.toLowerCase();
      // Ctrl on Windows/Linux, Cmd on Mac — whichever this browser's OS uses.
      const isClipboardCombo = (modifiers.includes("ctrl") || modifiers.includes("meta")) && !e.repeat;

      if (isClipboardCombo && (key === "c" || key === "x")) {
        sendRef.current({ type: "key", action: "down", key: e.key, modifiers });
        window.setTimeout(() => getClipboardRef.current(), CLIPBOARD_COPY_FETCH_DELAY_MS);
        return;
      }

      if (isClipboardCombo && key === "v") {
        // Push this browser's clipboard to the agent first, then forward the
        // paste keystroke — see CLIPBOARD_PASTE_DELAY_MS for why a delay is
        // needed even after the send.
        void setClipboardRef.current().finally(() => {
          window.setTimeout(
            () => sendRef.current({ type: "key", action: "down", key: e.key, modifiers }),
            CLIPBOARD_PASTE_DELAY_MS,
          );
        });
        return;
      }

      sendRef.current({ type: "key", action: "down", key: e.key, modifiers });
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (!enabledRef.current) return;
      e.preventDefault();
      const modifiers = collectModifiers(e);
      const doSend = () =>
        sendRef.current({ type: "key", action: "up", key: e.key, modifiers });

      // Paste's keydown above is deliberately delayed until setClipboard has
      // gone out. The physical keyup for the same keystroke fires on its own
      // schedule (whenever the user releases the key) and isn't part of that
      // delay chain, so without also delaying it here, "key up v" could reach
      // the agent before "key down v" — a key-up with no preceding key-down.
      // Releasing a key is always at or after pressing it, so adding the same
      // delay to both preserves their order.
      if ((modifiers.includes("ctrl") || modifiers.includes("meta")) && e.key.toLowerCase() === "v") {
        window.setTimeout(doSend, CLIPBOARD_PASTE_DELAY_MS);
        return;
      }
      doSend();
    };

    (canvas as HTMLElement).addEventListener("mousemove", onMouseMove);
    (canvas as HTMLElement).addEventListener("mousedown", onMouseDown);
    (canvas as HTMLElement).addEventListener("mouseup", onMouseUp);
    (canvas as HTMLElement).addEventListener("contextmenu", onContextMenu);
    (canvas as HTMLElement).addEventListener("wheel", onWheel, { passive: false });
    (canvas as HTMLElement).addEventListener("keydown", onKeyDown);
    (canvas as HTMLElement).addEventListener("keyup", onKeyUp);

    return () => {
      (canvas as HTMLElement).removeEventListener("mousemove", onMouseMove);
      (canvas as HTMLElement).removeEventListener("mousedown", onMouseDown);
      (canvas as HTMLElement).removeEventListener("mouseup", onMouseUp);
      (canvas as HTMLElement).removeEventListener("contextmenu", onContextMenu);
      (canvas as HTMLElement).removeEventListener("wheel", onWheel);
      (canvas as HTMLElement).removeEventListener("keydown", onKeyDown);
      (canvas as HTMLElement).removeEventListener("keyup", onKeyUp);
    };
  }, [canvasRef]);
}
