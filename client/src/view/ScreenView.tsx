import { useEffect, useRef, useState } from "react";
import type { StreamMode } from "@bcsa/shared";
import type { LatestFrame } from "../connect/useConnection";
import type { UseSoftKeyboard } from "../control/useSoftKeyboard";
import type { UseFullscreen } from "./useFullscreen";
import { backingStoreSize, computeFitRect, FIT_MODES, type FitMode } from "./fit";

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
  /**
   * The on-screen keyboard bridge, on touch devices. Rendered here rather than
   * alongside the canvas in App so the input sits inside the same stacking
   * context — a focused input outside it would scroll the page to reach itself.
   */
  softKeyboard?: UseSoftKeyboard;
  /** Fills the display with the screen view; see useFullscreen. */
  fullscreen?: UseFullscreen;
  /** Current layout of the frame within the view. */
  fit: FitMode;
  onSetFit: (mode: FitMode) => void;
  /**
   * The same value as `fit`, in a ref.
   *
   * Frames are drawn from callbacks owned by the decoder, which outlive any one
   * render — reading the prop there would pin whichever value was current when
   * the decoder was created, so changing the mode would not affect the picture
   * until the stream restarted.
   */
  fitRef: React.MutableRefObject<FitMode>;
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
 * That reasoning applied when every frame was a full JPEG. The default video
 * path is now H.264, where a frame costs ~7KB rather than ~267KB, so 60fps is
 * affordable and visibly smoother — and the adaptive controller walks the rate
 * back down on any link that cannot sustain it, rather than queueing.
 *
 * The MJPEG fallback still exists for agents without the in-process encoder,
 * and 60fps is expensive there; that path is protected by the agent's
 * backpressure, which drops rather than queues.
 */
export const MAX_FPS = 60;

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
  softKeyboard,
  fullscreen,
  fit,
  onSetFit,
  fitRef,
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
      // Size the canvas backing store from its displayed box, scaled for the
      // display's pixel density but never beyond the source resolution.
      const box = canvas.getBoundingClientRect();
      const { width: cw, height: ch } = backingStoreSize(
        box.width,
        box.height,
        img.width,
        img.height,
        globalThis.devicePixelRatio ?? 1,
      );
      if (canvas.width !== cw) canvas.width = cw;
      if (canvas.height !== ch) canvas.height = ch;

      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, cw, ch);

      // The same placement the H.264 path uses, so the two sources cannot
      // disagree about where the image is.
      const rect = computeFitRect(fitRef.current, img.width, img.height, cw, ch);
      ctx.drawImage(img, rect.dx, rect.dy, rect.dw, rect.dh);

      // Publish the image rectangle so the control layer can map clicks onto
      // the actual frame instead of the whole canvas.
      contentRectRef.current = rect;

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
        <div className="seg seg-sm fit-seg">
          {FIT_MODES.map((m) => (
            <button
              key={m.value}
              type="button"
              className={fit === m.value ? "active" : ""}
              onClick={() => onSetFit(m.value)}
              title={m.hint}
            >
              {m.label}
            </button>
          ))}
        </div>
        {fullscreen && (
          <button
            type="button"
            className={`btn btn-ghost fs-toggle ${fullscreen.active ? "active" : ""}`}
            onClick={fullscreen.toggle}
            title={fullscreen.active ? "Exit full screen" : "Full screen"}
            aria-label={fullscreen.active ? "Exit full screen" : "Full screen"}
          >
            {fullscreen.active ? "⤡ Exit" : "⤢ Full screen"}
          </button>
        )}
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
        {softKeyboard && (
          <input
            ref={softKeyboard.ref}
            className="soft-keyboard-input"
            // Every assist would corrupt the keystrokes: autocorrect rewrites
            // what was typed, autocapitalize changes case, and a spellcheck
            // underline implies text is being composed here when it is not.
            autoCapitalize="none"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
            aria-label="Remote keyboard input"
            tabIndex={-1}
            onFocus={softKeyboard.handlers.onFocus}
            onBlur={softKeyboard.handlers.onBlur}
          />
        )}
        {softKeyboard && controlEnabled && (
          <button
            type="button"
            className={`kbd-toggle ${softKeyboard.open ? "active" : ""}`}
            // Pointer-down, not click: a click would land after the input has
            // already lost focus, so the keyboard would close and reopen.
            onPointerDown={(e) => {
              e.preventDefault();
              softKeyboard.open ? softKeyboard.hide() : softKeyboard.show();
            }}
            aria-label={softKeyboard.open ? "Hide keyboard" : "Show keyboard"}
          >
            ⌨
          </button>
        )}
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
