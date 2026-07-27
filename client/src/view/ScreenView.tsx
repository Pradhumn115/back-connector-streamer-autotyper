import { useEffect, useRef, useState } from "react";
import type { StreamMode } from "@bcsa/shared";
import type { LatestFrame } from "../connect/useConnection";

/**
 * The rectangle (in canvas/CSS pixels) the letterboxed frame actually occupies
 * inside the canvas. Shared with the control layer so clicks map to the image,
 * not the black bars around it.
 */
export interface ContentRect {
  dx: number;
  dy: number;
  dw: number;
  dh: number;
}

interface ScreenViewProps {
  frame: LatestFrame | null;
  mode: StreamMode;
  controlEnabled: boolean;
  onSetMode: (mode: StreamMode) => void;
  canvasRef: React.RefObject<HTMLCanvasElement>;
  /** Written on each draw with the current letterbox rectangle. */
  contentRectRef: React.MutableRefObject<ContentRect>;
  /** Agent's detected display refresh rate, for the auto fps target readout. */
  refreshHz?: number;
  /**
   * State of the H.264-over-WebSocket video source, when the agent is sending
   * one. It shares the Classic canvas, so this view must know it is live —
   * otherwise the "No signal" overlay and the fps readout, both driven by JPEG
   * arrivals, would report a working stream as dead.
   */
  h264: { active: boolean; fps: number; status: string; error: string | null };
}

// Interval used for each mode (matches guidance in the protocol notes).
export const SCREENSHOT_INTERVAL_MS = 2000;
/**
 * Ceiling for auto fps in Classic mode.
 *
 * Classic is MJPEG, so every frame is a full intra frame with no inter-frame
 * prediction — a completely static desktop costs full price on every single
 * frame. Measured against a real 1920-wide capture, one frame is ~267KB, so
 * the old 120 ceiling (chosen to match the agent's ffmpeg cap, and reached on
 * any 120Hz display) asked for roughly 206 Mbit/s. No WiFi or Tailscale link
 * carries that, so the surplus simply queued on the agent and the picture fell
 * permanently behind real time.
 *
 * The agent now drops rather than queues (see MAX_QUEUED_FRAME_BYTES in
 * agent/src/connection/index.ts), which bounds the latency — but requesting
 * 120fps would still spend a JPEG encode on ~90 frames a second purely to
 * throw them away. 30fps is past what remote control needs, cuts the ask to
 * ~63 Mbit/s, and leaves the drop path as headroom rather than the norm.
 *
 * This is a Classic-only ceiling; the WebRTC path has its own per-tier fps cap
 * and real congestion control, and is the better choice over the internet.
 */
export const MAX_FPS = 30;

/**
 * Interval (ms) to request for a mode. Video auto-targets the agent's display
 * refresh rate (so you get whatever your screen can actually show), clamped to
 * MAX_FPS; falls back to 60fps if the refresh rate is unknown.
 */
export function intervalForMode(mode: StreamMode, refreshHz?: number): number {
  if (mode === "screenshot") return SCREENSHOT_INTERVAL_MS;
  const fps = Math.min(MAX_FPS, Math.max(1, Math.round(refreshHz ?? 60)));
  return Math.round(1000 / fps);
}

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
  contentRectRef,
  refreshHz,
  h264,
}: ScreenViewProps) {
  const targetFps = Math.min(MAX_FPS, Math.max(1, Math.round(refreshHz ?? 60)));
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

      // Publish the image rectangle so the control layer can map clicks onto
      // the actual frame instead of the whole (letterboxed) canvas.
      contentRectRef.current = { dx, dy, dw, dh };

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
    <>
      <div className="stage-toolbar">
        <div className="seg">
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
        <div className="readout">
          <>
              <span>
                mode <b>{mode}</b>
              </span>
              <span>
                fps <b>{(h264.active ? h264.fps : fps).toFixed(1)}</b>
              </span>
              {mode === "video" && (
                <span>
                  target <b>{targetFps}</b>
                </span>
              )}
              {frame && (
                <span>
                  seq <b>{frame.seq}</b>
                </span>
              )}
          </>
          <span>
            ctrl{" "}
            <b className={controlEnabled ? "on" : "off"}>
              {controlEnabled ? "ON" : "OFF"}
            </b>
          </span>
        </div>
      </div>
      <div className={`canvas-wrap ${controlEnabled ? "is-controlling" : ""}`}>
        <canvas
          ref={canvasRef}
          tabIndex={0}
          className={controlEnabled ? "canvas controllable" : "canvas"}
        />
        {!frame && !h264.active && (
          <div className="canvas-empty">
            {h264.status === "unsupported"
              ? "This browser can't decode the agent's video (no WebCodecs)"
              : h264.status === "error"
                ? `Video decode failed: ${h264.error ?? "unknown error"}`
                : h264.status === "waiting-for-keyframe"
                  ? "Waiting for a keyframe…"
                  : "No signal"}
          </div>
        )}
      </div>
    </>
  );
}
