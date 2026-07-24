import { useEffect, useRef, useState } from "react";
import type { StreamMode } from "@bcsa/shared";
import type { LatestFrame } from "../connect/useConnection";

interface ScreenViewProps {
  frame: LatestFrame | null;
  mode: StreamMode;
  controlEnabled: boolean;
  onSetMode: (mode: StreamMode) => void;
  canvasRef: React.RefObject<HTMLCanvasElement>;
}

// Interval used for each mode (matches guidance in the protocol notes).
export const MODE_INTERVAL_MS: Record<StreamMode, number> = {
  screenshot: 2000,
  video: 50,
};

/**
 * Draws the latest frame into a canvas, scaled to fit the canvas while
 * preserving aspect ratio (letterboxed). Tracks a rolling FPS estimate.
 */
export function ScreenView({
  frame,
  mode,
  controlEnabled,
  onSetMode,
  canvasRef,
}: ScreenViewProps) {
  const [fps, setFps] = useState<number>(0);
  const frameTimesRef = useRef<number[]>([]);
  const lastSeqRef = useRef<number>(-1);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !frame) return;

    // Update FPS estimate on genuinely new frames only.
    if (frame.seq !== lastSeqRef.current) {
      lastSeqRef.current = frame.seq;
      const now = performance.now();
      const times = frameTimesRef.current;
      times.push(now);
      // Keep only the last ~2 seconds of timestamps.
      while (times.length > 0 && now - times[0] > 2000) times.shift();
      if (times.length >= 2) {
        const span = (times[times.length - 1] - times[0]) / 1000;
        setFps(span > 0 ? (times.length - 1) / span : 0);
      }
    }

    const img = new Image();
    let revoked = false;
    img.onload = () => {
      // Size the canvas backing store to its displayed CSS size for crispness.
      const rect = canvas.getBoundingClientRect();
      const cw = Math.max(1, Math.round(rect.width));
      const ch = Math.max(1, Math.round(rect.height));
      if (canvas.width !== cw) canvas.width = cw;
      if (canvas.height !== ch) canvas.height = ch;

      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, cw, ch);

      // Fit preserving aspect ratio (letterbox).
      const scale = Math.min(cw / img.width, ch / img.height);
      const dw = img.width * scale;
      const dh = img.height * scale;
      const dx = (cw - dw) / 2;
      const dy = (ch - dh) / 2;
      ctx.drawImage(img, dx, dy, dw, dh);

      if (!revoked) {
        // The URL is owned by the connection hook, which revokes on replace;
        // we don't revoke here to avoid racing that lifecycle.
        revoked = true;
      }
    };
    img.src = frame.url;

    return () => {
      img.onload = null;
    };
  }, [frame, canvasRef]);

  return (
    <div className="screen-view">
      <div className="screen-toolbar">
        <div className="mode-toggle">
          <button
            className={mode === "screenshot" ? "active" : ""}
            onClick={() => onSetMode("screenshot")}
          >
            Screenshot
          </button>
          <button
            className={mode === "video" ? "active" : ""}
            onClick={() => onSetMode("video")}
          >
            Video
          </button>
        </div>
        <div className="screen-readout">
          <span>mode: {mode}</span>
          <span>fps: {fps.toFixed(1)}</span>
          {frame && <span>seq: {frame.seq}</span>}
          <span className={controlEnabled ? "ctl-on" : "ctl-off"}>
            {controlEnabled ? "control ON" : "control off"}
          </span>
        </div>
      </div>
      <div className="canvas-wrap">
        <canvas
          ref={canvasRef}
          tabIndex={0}
          className={controlEnabled ? "canvas controllable" : "canvas"}
        />
        {!frame && <div className="canvas-empty">No frames yet</div>}
      </div>
    </div>
  );
}
