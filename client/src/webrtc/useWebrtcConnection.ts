import { useCallback, useRef, useState } from "react";

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
 * Owns the browser-side RTCPeerConnection for WebRTC mode. The agent always
 * initiates (it has the tracks): handleOffer answers it and returns the SDP
 * to send back over the existing WSS control channel. Vanilla ICE — no
 * separate candidate exchange; createAnswer/setLocalDescription both resolve
 * only once ICE gathering completes, so the returned SDP already has candidates.
 */
export function useWebrtcConnection(): UseWebrtcConnection {
  const [status, setStatus] = useState<WebrtcStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);

  const stop = useCallback(() => {
    pcRef.current?.close();
    pcRef.current = null;
    setStream(null);
    setStatus("idle");
    setError(null);
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
    await pc.setRemoteDescription({ type: "offer", sdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    return pc.localDescription!.sdp;
  }, [stop]);

  const handleAgentState = useCallback((active: boolean, agentError?: string) => {
    if (active) {
      setStatus("connected");
      setError(null);
    } else {
      setStatus("error");
      setError(agentError ?? "WebRTC session ended");
      stop();
    }
  }, [stop]);

  return { status, error, stream, handleOffer, handleAgentState, stop };
}
