import { useEffect, useRef } from "react";
import type { ClientMessage } from "@bcsa/shared";

type Modifier = "ctrl" | "alt" | "shift" | "meta";
type SendFn = (msg: ClientMessage) => void;

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
 * the canvas's rendered box (which fills the element the frame is drawn into).
 */
function normalizedCoords(
  canvas: HTMLCanvasElement,
  clientX: number,
  clientY: number,
): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  const x = rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
  const y = rect.height > 0 ? (clientY - rect.top) / rect.height : 0;
  return {
    x: Math.min(1, Math.max(0, x)),
    y: Math.min(1, Math.max(0, y)),
  };
}

/**
 * Attaches mouse + keyboard handlers to a canvas element and translates them
 * into ClientMessages. `enabled` gates all input so the user can release
 * control. Keyboard events are captured only while the canvas is focused.
 */
export function useRemoteControl(
  canvasRef: React.RefObject<HTMLCanvasElement>,
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
      const { x, y } = normalizedCoords(canvas, e.clientX, e.clientY);
      sendRef.current({ type: "mouse", action: "move", x, y });
    };

    const onMouseDown = (e: MouseEvent) => {
      if (!enabledRef.current) return;
      canvas.focus();
      const { x, y } = normalizedCoords(canvas, e.clientX, e.clientY);
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
      const { x, y } = normalizedCoords(canvas, e.clientX, e.clientY);
      sendRef.current({
        type: "mouse",
        action: "up",
        x,
        y,
        button: buttonName(e.button),
      });
    };

    const onClick = (e: MouseEvent) => {
      if (!enabledRef.current) return;
      const { x, y } = normalizedCoords(canvas, e.clientX, e.clientY);
      sendRef.current({
        type: "mouse",
        action: "click",
        x,
        y,
        button: buttonName(e.button),
      });
    };

    const onContextMenu = (e: MouseEvent) => {
      if (!enabledRef.current) return;
      // Prevent the browser menu so right-click reaches the agent.
      e.preventDefault();
      const { x, y } = normalizedCoords(canvas, e.clientX, e.clientY);
      sendRef.current({
        type: "mouse",
        action: "click",
        x,
        y,
        button: "right",
      });
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

    canvas.addEventListener("mousemove", onMouseMove);
    canvas.addEventListener("mousedown", onMouseDown);
    canvas.addEventListener("mouseup", onMouseUp);
    canvas.addEventListener("click", onClick);
    canvas.addEventListener("contextmenu", onContextMenu);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("keydown", onKeyDown);
    canvas.addEventListener("keyup", onKeyUp);

    return () => {
      canvas.removeEventListener("mousemove", onMouseMove);
      canvas.removeEventListener("mousedown", onMouseDown);
      canvas.removeEventListener("mouseup", onMouseUp);
      canvas.removeEventListener("click", onClick);
      canvas.removeEventListener("contextmenu", onContextMenu);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("keydown", onKeyDown);
      canvas.removeEventListener("keyup", onKeyUp);
    };
  }, [canvasRef]);
}
