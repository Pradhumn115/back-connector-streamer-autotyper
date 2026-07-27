import { useCallback, useEffect, useRef, useState } from "react";
import type { DecodedFrame } from "@bcsa/shared";

/**
 * Decodes the agent's H.264 frames with WebCodecs and paints them to a canvas.
 *
 * ## Why WebCodecs rather than WebRTC
 *
 * WebRTC solves NAT traversal and adaptive real-time media. This project needs
 * neither: the agent is directly addressable over LAN or Tailscale, so the
 * whole SDP/ICE/DTLS layer was pure cost — and it was where every video bug
 * lived (a profile that did not match the SDP, a frame size violating the
 * negotiated level, multi-slice frames, a keyframe lost to a DTLS race, and
 * Firefox failing ICE outright).
 *
 * Here there is nothing to negotiate. The decoder is configured with the exact
 * codec string the agent encodes, so the two cannot disagree. Frames arrive on
 * the same WebSocket as everything else, which also means video works over the
 * Cloudflare Tunnel path, where WebRTC cannot go at all.
 *
 * ## Waiting for a keyframe is mandatory, not defensive
 *
 * H.264 delta frames are meaningless without the keyframe they reference.
 * Feeding one to a decoder that has not been primed produces either an error or
 * silent corruption, so everything before the first keyframe is discarded. The
 * agent forces an IDR when a session starts, so this wait is short — but if it
 * is ever skipped, the symptom is a permanently black picture, which is exactly
 * the failure this transport was rebuilt to eliminate.
 */
export type H264Status = "idle" | "waiting-for-keyframe" | "decoding" | "unsupported" | "error";

export interface UseH264Decoder {
  status: H264Status;
  error: string | null;
  /** Feed one decoded envelope; ignores non-H264 formats. */
  pushFrame: (frame: DecodedFrame) => void;
  reset: () => void;
}

/**
 * Constrained Baseline, level 3.1 — matches what the agent's encoder emits
 * (`-profile:v baseline`, verified with ffprobe as "Constrained Baseline").
 * Every engine tested (Chromium, Firefox, WebKit) reports this as supported.
 */
const CODEC = "avc1.42E01F";

export function useH264Decoder(canvasRef: React.RefObject<HTMLCanvasElement>): UseH264Decoder {
  const [status, setStatus] = useState<H264Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const decoderRef = useRef<VideoDecoder | null>(null);
  /** Until a keyframe arrives, delta frames cannot be decoded and are dropped. */
  const primedRef = useRef(false);

  const teardown = useCallback(() => {
    try {
      if (decoderRef.current && decoderRef.current.state !== "closed") {
        decoderRef.current.close();
      }
    } catch {
      // Closing an already-errored decoder throws; nothing useful to do.
    }
    decoderRef.current = null;
    primedRef.current = false;
  }, []);

  const reset = useCallback(() => {
    teardown();
    setStatus("idle");
    setError(null);
  }, [teardown]);

  useEffect(() => teardown, [teardown]);

  const ensureDecoder = useCallback((): VideoDecoder | null => {
    if (decoderRef.current && decoderRef.current.state !== "closed") return decoderRef.current;
    if (typeof VideoDecoder === "undefined") {
      setStatus("unsupported");
      setError("This browser has no WebCodecs VideoDecoder.");
      return null;
    }
    const decoder = new VideoDecoder({
      output: (frame) => {
        const canvas = canvasRef.current;
        if (canvas) {
          // Size the canvas from the stream rather than assuming: the agent
          // picks the encode size from the remote display's aspect ratio, and
          // it changes if the encoder is reopened at a new resolution.
          if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
            canvas.width = frame.displayWidth;
            canvas.height = frame.displayHeight;
          }
          canvas.getContext("2d")?.drawImage(frame, 0, 0);
        }
        // VideoFrames hold GPU/system memory and are not garbage collected —
        // failing to close every one starves the decoder within seconds.
        frame.close();
        setStatus((s) => (s === "decoding" ? s : "decoding"));
      },
      error: (e) => {
        setStatus("error");
        setError(String(e));
        primedRef.current = false;
      },
    });
    decoder.configure({ codec: CODEC, optimizeForLatency: true });
    decoderRef.current = decoder;
    setStatus("waiting-for-keyframe");
    return decoder;
  }, [canvasRef]);

  const pushFrame = useCallback(
    (frame: DecodedFrame) => {
      const decoder = ensureDecoder();
      if (!decoder || decoder.state === "closed") return;

      if (!primedRef.current) {
        if (!frame.keyframe) return; // undecodable without its reference frame
        primedRef.current = true;
      }
      try {
        decoder.decode(
          new EncodedVideoChunk({
            type: frame.keyframe ? "key" : "delta",
            // The envelope carries agent wall-clock ms; WebCodecs wants
            // microseconds and only uses this for ordering.
            timestamp: Math.round(frame.timestamp * 1000),
            data: frame.payload,
          }),
        );
      } catch (e) {
        setStatus("error");
        setError(String(e));
        primedRef.current = false;
      }
    },
    [ensureDecoder],
  );

  return { status, error, pushFrame, reset };
}
