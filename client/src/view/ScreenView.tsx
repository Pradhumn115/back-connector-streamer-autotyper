import { useEffect, useRef, useState } from "react";
import type { StreamMode, VideoCodecPreference } from "@bcsa/shared";
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
  /** Which transport is active: Classic (JPEG/PCM over WS) or WebRTC. */
  transport: "classic" | "webrtc";
  /**
   * State of the H.264-over-WebSocket video source, when the agent is sending
   * one. It shares the Classic canvas, so this view must know it is live —
   * otherwise the "No signal" overlay and the fps readout, both driven by JPEG
   * arrivals, would report a working stream as dead.
   */
  h264: { active: boolean; fps: number; status: string; error: string | null };
  /** Video codec the agent is asked to offer; "auto" lets the browser choose. */
  videoCodec: VideoCodecPreference;
  onSetVideoCodec: (codec: VideoCodecPreference) => void;
  onSetTransport: (t: "classic" | "webrtc") => void;
  /** True when connected via the Cloudflare Tunnel target, where WebRTC isn't available. */
  transportGateDisabled: boolean;
  webrtcStream: MediaStream | null;
  videoRef: React.RefObject<HTMLVideoElement>;
  /** Whether the WebRTC <video> element plays its audio track out loud. Independent of transcription. */
  webrtcAudioEnabled: boolean;
  onToggleWebrtcAudio: (enabled: boolean) => void;
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
  transport,
  h264,
  videoCodec,
  onSetVideoCodec,
  onSetTransport,
  transportGateDisabled,
  webrtcStream,
  videoRef,
  webrtcAudioEnabled,
  onToggleWebrtcAudio,
}: ScreenViewProps) {
  const targetFps = Math.min(MAX_FPS, Math.max(1, Math.round(refreshHz ?? 60)));
  const [fps, setFps] = useState<number>(0);
  const frameTimesRef = useRef<number[]>([]);
  const lastSeqRef = useRef<number>(-1);

  // Real fps for WebRTC video, computed from actual decoded frame callbacks
  // (rvfc) rather than the Classic `fps` state above, which is never updated
  // in WebRTC mode since no `frame` (JPEG-over-WS) messages arrive then.
  const [webrtcFps, setWebrtcFps] = useState<number | null>(null);
  const [webrtcResolution, setWebrtcResolution] = useState<{ w: number; h: number } | null>(null);
  const webrtcFrameTimesRef = useRef<number[]>([]);

  // Attach the WebRTC MediaStream to the <video> element whenever it changes.
  // `transport` is in the deps too: switching Classic -> WebRTC -> Classic ->
  // WebRTC unmounts/remounts the <video> element (ScreenView renders either
  // <video> or <canvas>), so a stable stream reference alone wouldn't
  // re-trigger this effect and re-attach to the new element.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.srcObject = webrtcStream;
  }, [webrtcStream, videoRef, transport]);

  // The <video> element has no explicit object-fit in CSS, so it falls back
  // to the UA default of `contain` — i.e. it IS letterboxed whenever its
  // intrinsic aspect ratio differs from its box, same as the Classic canvas.
  // contentRectRef is otherwise only ever written by the canvas-draw effect
  // below, so without this, WebRTC mode would map clicks against stale or
  // zeroed rects (wrong whenever entered before any Classic frame drew, or
  // after a window resize while in WebRTC). Compute and publish the video's
  // actual content rect, refreshed on metadata load and on resize.
  useEffect(() => {
    const video = videoRef.current;
    if (transport !== "webrtc" || !video) return;

    // Reset immediately so stale Classic-mode rects never leak into WebRTC
    // mode even before the first metadata/resize computation lands.
    contentRectRef.current = { dx: 0, dy: 0, dw: 0, dh: 0 };

    const updateRect = () => {
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (vw === 0 || vh === 0) return;
      const rect = video.getBoundingClientRect();
      const cw = rect.width;
      const ch = rect.height;
      if (cw === 0 || ch === 0) return;
      const scale = Math.min(cw / vw, ch / vh);
      const dw = vw * scale;
      const dh = vh * scale;
      const dx = (cw - dw) / 2;
      const dy = (ch - dh) / 2;
      contentRectRef.current = { dx, dy, dw, dh };
    };

    updateRect();
    video.addEventListener("loadedmetadata", updateRect);
    const resizeObserver = new ResizeObserver(updateRect);
    resizeObserver.observe(video);

    return () => {
      video.removeEventListener("loadedmetadata", updateRect);
      resizeObserver.disconnect();
    };
  }, [transport, webrtcStream, videoRef, contentRectRef]);

  // Track real WebRTC video fps + resolution from actual decoded frames via
  // requestVideoFrameCallback (Chrome/Edge only — feature-detected below; on
  // browsers without it we simply omit the fps figure rather than crash).
  useEffect(() => {
    if (transport !== "webrtc") {
      setWebrtcFps(null);
      setWebrtcResolution(null);
      webrtcFrameTimesRef.current = [];
      return;
    }
    const video = videoRef.current as
      | (HTMLVideoElement & {
          requestVideoFrameCallback?: (
            cb: (now: number, metadata: { width: number; height: number }) => void
          ) => number;
          cancelVideoFrameCallback?: (handle: number) => void;
        })
      | null;
    if (!video || typeof video.requestVideoFrameCallback !== "function") {
      setWebrtcFps(null);
      return;
    }

    webrtcFrameTimesRef.current = [];
    let handle: number | null = null;
    let cancelled = false;

    const onFrame = (_now: number, metadata: { width: number; height: number }) => {
      if (cancelled) return;
      setWebrtcResolution({ w: metadata.width, h: metadata.height });

      // Same rolling ~2s window pattern as the Classic fps logic above.
      const nowMs = performance.now();
      const times = webrtcFrameTimesRef.current;
      times.push(nowMs);
      while (times.length > 0 && nowMs - times[0] > 2000) times.shift();
      if (times.length >= 2) {
        const span = (times[times.length - 1] - times[0]) / 1000;
        setWebrtcFps(span > 0 ? (times.length - 1) / span : 0);
      }

      handle = video.requestVideoFrameCallback!(onFrame);
    };

    handle = video.requestVideoFrameCallback(onFrame);

    return () => {
      cancelled = true;
      if (handle !== null && typeof video.cancelVideoFrameCallback === "function") {
        video.cancelVideoFrameCallback(handle);
      }
    };
  }, [transport, webrtcStream, videoRef]);

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
            disabled={transport === "webrtc"}
            title={
              transport === "webrtc"
                ? "Not available while WebRTC is active"
                : undefined
            }
          >
            Screenshot
          </button>
          <button
            className={mode === "video" ? "active" : ""}
            onClick={() => onSetMode("video")}
            disabled={transport === "webrtc"}
            title={
              transport === "webrtc"
                ? "Not available while WebRTC is active"
                : undefined
            }
          >
            Video
          </button>
        </div>
        <div className="seg">
          <button
            className={transport === "classic" ? "active" : ""}
            onClick={() => onSetTransport("classic")}
          >
            Classic
          </button>
          <button
            className={transport === "webrtc" ? "active" : ""}
            onClick={() => onSetTransport("webrtc")}
            disabled={transportGateDisabled}
            title={transportGateDisabled ? "Not available over Cloudflare Tunnel" : undefined}
          >
            WebRTC
          </button>
        </div>
        {/*
          Codec picker, shown only while WebRTC is active since it has no
          meaning for Classic. "Auto" offers every codec and lets the browser
          pick, which is normally right — the explicit choices exist because
          that pick is invisible and occasionally wrong, and pinning one turns
          a blank picture into a two-click experiment.
        */}
        {transport === "webrtc" && (
          <div className="seg">
            {(
              [
                ["auto", "Auto", "Offer every codec; the browser picks"],
                ["h264", "H.264", "Hardware decode where available"],
                ["vp8", "VP8", "Required by every WebRTC browser; the universal fallback"],
              ] as const
            ).map(([value, label, title]) => (
              <button
                key={value}
                className={videoCodec === value ? "active" : ""}
                onClick={() => onSetVideoCodec(value)}
                title={title}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        <div className="readout">
          {transport === "webrtc" ? (
            <>
              <span>
                transport <b>WebRTC</b>
              </span>
              {webrtcFps !== null && (
                <span>
                  fps <b>{webrtcFps.toFixed(1)}</b>
                </span>
              )}
              {webrtcResolution && (
                <span>
                  res{" "}
                  <b>
                    {webrtcResolution.w}x{webrtcResolution.h}
                  </b>
                </span>
              )}
              <button
                className="btn btn-ghost btn-xs"
                onClick={() => onToggleWebrtcAudio(!webrtcAudioEnabled)}
                title={
                  webrtcAudioEnabled
                    ? "Mute agent audio playback"
                    : "Unmute agent audio playback (independent of transcription)"
                }
              >
                {webrtcAudioEnabled ? "🔊 Audio on" : "🔇 Audio off"}
              </button>
            </>
          ) : (
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
          )}
          <span>
            ctrl{" "}
            <b className={controlEnabled ? "on" : "off"}>
              {controlEnabled ? "ON" : "OFF"}
            </b>
          </span>
        </div>
      </div>
      <div className={`canvas-wrap ${controlEnabled ? "is-controlling" : ""}`}>
        {transport === "webrtc" ? (
          <video
            ref={videoRef}
            tabIndex={0}
            autoPlay
            playsInline
            muted={!webrtcAudioEnabled}
            className={controlEnabled ? "canvas controllable" : "canvas"}
          />
        ) : (
          <canvas
            ref={canvasRef}
            tabIndex={0}
            className={controlEnabled ? "canvas controllable" : "canvas"}
          />
        )}
        {transport === "classic" && !frame && !h264.active && (
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
