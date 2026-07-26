import { useCallback, useEffect, useRef, useState } from "react";

export type WebrtcStatus = "idle" | "connecting" | "connected" | "error";

export interface UseWebrtcConnection {
  status: WebrtcStatus;
  error: string | null;
  stream: MediaStream | null;
  handleOffer: (sdp: string) => Promise<string>;
  handleAgentState: (active: boolean, error?: string) => void;
  stop: () => void;
}

/**
 * Resolves once the given RTCPeerConnection has finished gathering local ICE
 * candidates. Resolves immediately if gathering is already complete;
 * otherwise subscribes to `icegatheringstatechange` and resolves the first
 * time the state becomes "complete".
 */
function waitForIceGatheringComplete(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === "complete") {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const onChange = () => {
      if (pc.iceGatheringState === "complete") {
        pc.removeEventListener("icegatheringstatechange", onChange);
        resolve();
      }
    };
    pc.addEventListener("icegatheringstatechange", onChange);
  });
}

/**
 * Owns the browser-side RTCPeerConnection for WebRTC mode. The agent always
 * initiates (it has the tracks): handleOffer answers it and returns the SDP
 * to send back over the existing WSS control channel. Vanilla ICE — no
 * separate candidate exchange, so before returning the answer SDP we
 * explicitly wait (via waitForIceGatheringComplete) for
 * `pc.iceGatheringState` to become "complete". Note that
 * setLocalDescription()'s promise resolves as soon as the description is
 * set, NOT once gathering finishes — gathering is only observable via
 * iceGatheringState / icegatheringstatechange, hence the explicit wait.
 */
export function useWebrtcConnection(): UseWebrtcConnection {
  const [status, setStatus] = useState<WebrtcStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);

  const stop = useCallback((resetStatus: boolean = true) => {
    pcRef.current?.close();
    pcRef.current = null;
    setStream(null);
    if (resetStatus) {
      setStatus("idle");
      setError(null);
    }
  }, []);

  const handleOffer = useCallback(async (sdp: string): Promise<string> => {
    stop();
    setStatus("connecting");
    const pc = new RTCPeerConnection();
    pcRef.current = pc;
    const remoteStream = new MediaStream();
    pc.ontrack = (e) => {
      remoteStream.addTrack(e.track);
      setStream(new MediaStream(remoteStream.getTracks()));
    };
    try {
      await pc.setRemoteDescription({ type: "offer", sdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await waitForIceGatheringComplete(pc);
      return pc.localDescription!.sdp;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setStatus("error");
      setError(message);
      pc.close();
      if (pcRef.current === pc) {
        pcRef.current = null;
      }
      setStream(null);
      throw err;
    }
  }, [stop]);

  const handleAgentState = useCallback((active: boolean, agentError?: string) => {
    if (active) {
      setStatus("connected");
      setError(null);
    } else {
      // Close the connection and clear the ref/stream directly rather than
      // calling stop(), which would reset status/error back to idle/null
      // and clobber the error state we're about to set.
      pcRef.current?.close();
      pcRef.current = null;
      setStream(null);
      setStatus("error");
      setError(agentError ?? "WebRTC session ended");
    }
  }, []);

  useEffect(() => {
    return () => {
      pcRef.current?.close();
      pcRef.current = null;
    };
  }, []);

  return { status, error, stream, handleOffer, handleAgentState, stop };
}
