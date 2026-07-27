import { useEffect, useRef } from "react";
import type { ClientMessage } from "@bcsa/shared";
import type { ContentRect } from "../view/ScreenView";
import { mapToNormalized } from "./mapCoords";

type Modifier = "ctrl" | "alt" | "shift" | "meta";
type SendFn = (msg: ClientMessage) => void;
type ControlSurface = HTMLCanvasElement | HTMLVideoElement;

// Throttle mousemove to ~50/s to avoid flooding the socket.
const MOVE_INTERVAL_MS = 20;

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
  // The canvas backing store is sized 1:1 with its CSS box, and the content
  // rect is in those same units, so we can offset directly by the CSS rect.
  return mapToNormalized(
    clientX - rect.left,
    clientY - rect.top,
    content,
    rect.width,
    rect.height,
  );
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
): void {
  // Keep the latest send/enabled in refs so listeners stay stable.
  const sendRef = useRef<SendFn>(send);
  const enabledRef = useRef<boolean>(enabled);
  const lastMoveRef = useRef<number>(0);

  useEffect(() => {
    sendRef.current = send;
  }, [send]);
  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

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
      sendRef.current({
        type: "key",
        action: "down",
        key: e.key,
        modifiers: collectModifiers(e),
      });
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (!enabledRef.current) return;
      e.preventDefault();
      sendRef.current({
        type: "key",
        action: "up",
        key: e.key,
        modifiers: collectModifiers(e),
      });
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
