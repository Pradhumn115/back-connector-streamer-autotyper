import { useCallback, useEffect, useRef, useState } from "react";
import { decodeFrame, isFrame, type DecodedFrame } from "@bcsa/shared";

/**
 * Receives video frames over QUIC instead of the control WebSocket.
 *
 * ## Why
 *
 * The WebSocket is TCP: one lost packet stalls every frame behind it until it
 * is retransmitted, and for live video that retransmission is usually
 * worthless because the frame is stale by the time it lands. QUIC gives each
 * stream its own ordering, so loss in one frame never blocks the next.
 *
 * ## Why this is additive, never a replacement
 *
 * Two things this cannot do, both of which the WebSocket can:
 *
 *  - Safari has no working WebTransport at time of writing, so it must keep
 *    taking video over the WebSocket.
 *  - A Cloudflare Tunnel carries HTTP, not UDP, so QUIC has no route there —
 *    and that is precisely the path used for access from anywhere.
 *
 * So this connects opportunistically and reports failure as "not available"
 * rather than as an error. The agent watches for a session and keeps sending
 * over the WebSocket until one exists, so a browser that cannot connect here
 * never notices.
 *
 * ## The certificate is verified by hash, not by the trust store
 *
 * The agent's certificate is self-signed, and a browser will not open a
 * WebTransport session to one unless the page supplies its SHA-256 via
 * `serverCertificateHashes`. The hash arrives in `agentInfo`, over the
 * already-authenticated control channel, so only a client that proved it knows
 * the secret can connect. This also means there is no certificate for the user
 * to accept — unlike the HTTPS path, which needs accepting once per address.
 */
export type WebtransportStatus = "idle" | "unsupported" | "connecting" | "connected" | "failed";

export interface UseWebtransport {
  status: WebtransportStatus;
  /** Frames received over QUIC since connecting; 0 means the fallback is carrying video. */
  frames: number;
  connect: (host: string, port: number, certHash: string) => void;
  disconnect: () => void;
}

/** Hex SHA-256 -> bytes, for serverCertificateHashes. */
function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function useWebtransport(onFrame: (frame: DecodedFrame) => void): UseWebtransport {
  const [status, setStatus] = useState<WebtransportStatus>("idle");
  const [frames, setFrames] = useState(0);
  const transportRef = useRef<{ close: () => void } | null>(null);
  const onFrameRef = useRef(onFrame);
  onFrameRef.current = onFrame;
  /** Bumped on every connect/disconnect so a superseded read loop exits. */
  const generationRef = useRef(0);

  const disconnect = useCallback(() => {
    generationRef.current++;
    try {
      transportRef.current?.close();
    } catch {
      // Already closed.
    }
    transportRef.current = null;
    setStatus("idle");
    setFrames(0);
  }, []);

  useEffect(() => disconnect, [disconnect]);

  const connect = useCallback(
    (host: string, port: number, certHash: string) => {
      const WT = (globalThis as { WebTransport?: typeof WebTransport }).WebTransport;
      if (typeof WT === "undefined") {
        setStatus("unsupported");
        return;
      }
      generationRef.current++;
      const generation = generationRef.current;
      setStatus("connecting");

      let transport: WebTransport;
      try {
        transport = new WT(`https://${host}:${port}/video`, {
          serverCertificateHashes: [
            { algorithm: "sha-256", value: hexToBytes(certHash).buffer as ArrayBuffer },
          ],
        });
      } catch {
        setStatus("failed");
        return;
      }
      transportRef.current = transport;

      void (async () => {
        try {
          await transport.ready;
          if (generation !== generationRef.current) return;
          setStatus("connected");

          const reader = transport.incomingUnidirectionalStreams.getReader();
          for (;;) {
            const { value: stream, done } = await reader.read();
            if (done || generation !== generationRef.current) break;
            if (!stream) continue;
            // Each frame arrives on its own stream, so a frame is complete when
            // its stream ends — no length prefix or framing layer needed.
            void readFrame(stream as ReadableStream<Uint8Array>, generation);
          }
        } catch {
          if (generation === generationRef.current) setStatus("failed");
        }
      })();

      async function readFrame(stream: ReadableStream<Uint8Array>, generation: number) {
        try {
          const reader = stream.getReader();
          const chunks: Uint8Array[] = [];
          let total = 0;
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value) {
              chunks.push(value);
              total += value.length;
            }
          }
          if (generation !== generationRef.current) return;
          const bytes = new Uint8Array(total);
          let offset = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.length;
          }
          if (!isFrame(bytes)) return;
          const decoded = decodeFrame(bytes);
          if (!decoded) return;
          setFrames((n) => n + 1);
          onFrameRef.current(decoded);
        } catch {
          // A truncated stream is one lost frame; the next keyframe recovers.
        }
      }
    },
    [],
  );

  return { status, frames, connect, disconnect };
}
