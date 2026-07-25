import { useCallback, useEffect, useRef, useState } from "react";
import type { DecodedAudioFrame } from "@bcsa/shared";
import { pcmS16ToFloat32, AudioWindower } from "./pcm";

export type ModelStatus = "idle" | "loading" | "ready" | "error";

// 5-second, non-overlapping windows at 16 kHz. Longer windows give Whisper more
// context (better accuracy) at the cost of caption latency; non-overlapping
// avoids having to dedupe repeated words across windows.
const SAMPLE_RATE = 16000;
const WINDOW_SAMPLES = 5 * SAMPLE_RATE;
const HOP_SAMPLES = WINDOW_SAMPLES;

export interface UseAudioTranscription {
  status: ModelStatus;
  /** Model-download progress 0..100 while status === "loading". */
  progress: number;
  transcript: string;
  device: string | null;
  error: string | null;
  /** Load the model (if needed) and begin accepting frames. */
  start: () => void;
  /** Stop accepting frames (keeps the loaded model for a fast restart). */
  stop: () => void;
  /** Clear the transcript text. */
  reset: () => void;
  /** Feed one decoded audio frame from the connection. Stable identity. */
  pushFrame: (frame: DecodedAudioFrame) => void;
}

/**
 * Owns the Whisper worker and turns incoming PCM audio frames into a running
 * transcript. Frame ingestion is gated by refs (not React state) so `pushFrame`
 * keeps a stable identity and never suffers stale-closure readiness checks.
 */
export function useAudioTranscription(): UseAudioTranscription {
  const [status, setStatus] = useState<ModelStatus>("idle");
  const [progress, setProgress] = useState(0);
  const [transcript, setTranscript] = useState("");
  const [device, setDevice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const workerRef = useRef<Worker | null>(null);
  const windowerRef = useRef(new AudioWindower(WINDOW_SAMPLES, HOP_SAMPLES));
  const activeRef = useRef(false);
  const readyRef = useRef(false);

  const ensureWorker = useCallback((): Worker => {
    if (workerRef.current) return workerRef.current;
    const w = new Worker(new URL("./transcriberWorker.ts", import.meta.url), {
      type: "module",
    });
    w.onmessage = (e: MessageEvent) => {
      const m = e.data;
      switch (m?.type) {
        case "progress":
          setProgress(Math.round(m.progress));
          break;
        case "ready":
          readyRef.current = true;
          setDevice(m.device ?? null);
          setStatus("ready");
          break;
        case "result":
          setTranscript((t) => (t ? `${t} ${m.text}` : m.text));
          break;
        case "error":
          setError(m.error);
          setStatus("error");
          break;
      }
    };
    workerRef.current = w;
    return w;
  }, []);

  const start = useCallback(() => {
    setError(null);
    activeRef.current = true;
    windowerRef.current.reset();
    const w = ensureWorker();
    if (!readyRef.current) setStatus("loading");
    w.postMessage({ type: "load" });
  }, [ensureWorker]);

  const stop = useCallback(() => {
    activeRef.current = false;
  }, []);

  const reset = useCallback(() => setTranscript(""), []);

  const pushFrame = useCallback((frame: DecodedAudioFrame) => {
    if (!activeRef.current || !readyRef.current) return;
    // Agent guarantees 16 kHz mono; skip anything unexpected rather than
    // feeding the model mis-rated audio.
    if (frame.sampleRate !== SAMPLE_RATE || frame.channels !== 1) return;
    const samples = pcmS16ToFloat32(frame.payload);
    for (const win of windowerRef.current.push(samples)) {
      // Transfer the buffer to avoid a copy across the worker boundary.
      workerRef.current?.postMessage({ type: "transcribe", audio: win }, [win.buffer]);
    }
  }, []);

  // Terminate the worker on unmount.
  useEffect(() => {
    return () => {
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, []);

  return { status, progress, transcript, device, error, start, stop, reset, pushFrame };
}
