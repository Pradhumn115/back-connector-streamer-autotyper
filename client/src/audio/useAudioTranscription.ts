import { useCallback, useEffect, useRef, useState } from "react";
import type { DecodedAudioFrame } from "@bcsa/shared";
import { pcmS16ToFloat32 } from "./pcm";
import { segmentSpeech, concatFloat32, tailRms } from "./vad";

export type ModelStatus = "idle" | "loading" | "ready" | "error";
export type TranscribeMode = "live" | "record";

const SAMPLE_RATE = 16000;
const LIVE_TICK_MS = 1200; // how often the live loop inspects the buffer
const LIVE_MIN_SAMPLES = 1.0 * SAMPLE_RATE; // wait for ≥1s before processing
const LIVE_MAX_SAMPLES = 20 * SAMPLE_RATE; // force-flush cap (~20s)
const LIVE_TAIL_SAMPLES = 0.4 * SAMPLE_RATE; // trailing window checked for a pause
const LIVE_SILENCE_RMS = 0.008; // tail RMS below this = the speaker paused
const RECORD_CHUNK_S = 30; // Whisper long-form chunking for record takes

export interface UseAudioTranscription {
  status: ModelStatus;
  progress: number;
  device: string | null;
  error: string | null;
  transcript: string;
  reset: () => void;
  mode: TranscribeMode;
  setMode: (m: TranscribeMode) => void;
  // live
  liveActive: boolean;
  startLive: () => void;
  stopLive: () => void;
  // record
  recording: boolean;
  transcribing: boolean;
  elapsedMs: number;
  startRecording: () => void;
  pauseRecording: () => void;
  // frame ingestion (stable identity, safe to pass to useConnection)
  pushFrame: (frame: DecodedAudioFrame) => void;
}

/**
 * Owns the Whisper worker and Silero VAD, and turns the agent's audio into text
 * two ways:
 *  - **Live:** VAD-gated streaming — buffer PCM, and when the speaker pauses
 *    (trailing near-silence), transcribe the trimmed speech as one utterance.
 *    Silence never reaches Whisper, so no "you" hallucinations or window repeats.
 *  - **Record:** buffer everything while recording; on pause, VAD-segment the
 *    whole take and transcribe it (long-form) into the transcript.
 * All gating uses refs so `pushFrame` keeps a stable identity.
 */
export function useAudioTranscription(): UseAudioTranscription {
  const [status, setStatus] = useState<ModelStatus>("idle");
  const [progress, setProgress] = useState(0);
  const [device, setDevice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState("");
  const [mode, setModeState] = useState<TranscribeMode>("live");
  const [liveActive, setLiveActive] = useState(false);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);

  const workerRef = useRef<Worker | null>(null);
  const readyRef = useRef(false);
  const readyWaitersRef = useRef<Array<() => void>>([]);
  const reqSeqRef = useRef(0);
  const pendingRef = useRef(
    new Map<number, { resolve: (t: string) => void; reject: (e: Error) => void }>(),
  );

  const modeRef = useRef<TranscribeMode>("live");
  const liveActiveRef = useRef(false);
  const recordingRef = useRef(false);
  const liveBusyRef = useRef(false);

  const liveChunksRef = useRef<Float32Array[]>([]);
  const liveLenRef = useRef(0);
  const recordChunksRef = useRef<Float32Array[]>([]);

  const liveTimerRef = useRef<number | null>(null);
  const elapsedTimerRef = useRef<number | null>(null);
  const recordStartRef = useRef(0);

  // ---- worker plumbing (id-correlated requests) ----
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
          readyWaitersRef.current.splice(0).forEach((r) => r());
          break;
        case "result": {
          const p = pendingRef.current.get(m.id);
          if (p) {
            pendingRef.current.delete(m.id);
            p.resolve(m.text ?? "");
          }
          break;
        }
        case "error":
          if (m.id != null) {
            const p = pendingRef.current.get(m.id);
            if (p) {
              pendingRef.current.delete(m.id);
              p.reject(new Error(m.error));
            }
          } else {
            // Load failure: surface it and release any awaiting requests so they
            // fail fast instead of hanging.
            setError(m.error);
            setStatus("error");
            readyWaitersRef.current.splice(0).forEach((r) => r());
          }
          break;
      }
    };
    workerRef.current = w;
    return w;
  }, []);

  const loadModel = useCallback(() => {
    setError(null);
    const w = ensureWorker();
    if (!readyRef.current) setStatus("loading");
    w.postMessage({ type: "load" });
  }, [ensureWorker]);

  const awaitReady = useCallback((): Promise<void> => {
    if (readyRef.current) return Promise.resolve();
    return new Promise((resolve) => readyWaitersRef.current.push(resolve));
  }, []);

  const transcribeInWorker = useCallback(
    async (audio: Float32Array, chunkLengthS?: number): Promise<string> => {
      await awaitReady();
      if (!readyRef.current) throw new Error("speech model not ready");
      const w = ensureWorker();
      const id = ++reqSeqRef.current;
      return new Promise<string>((resolve, reject) => {
        pendingRef.current.set(id, { resolve, reject });
        w.postMessage({ type: "transcribe", id, audio, chunkLengthS }, [audio.buffer]);
      });
    },
    [awaitReady, ensureWorker],
  );

  const appendText = useCallback((text: string) => {
    const t = text.trim();
    if (t) setTranscript((prev) => (prev ? `${prev} ${t}` : t));
  }, []);

  // ---- live loop ----
  const runLiveTick = useCallback(async () => {
    if (liveBusyRef.current || !liveActiveRef.current || !readyRef.current) return;
    if (liveLenRef.current < LIVE_MIN_SAMPLES) return;
    liveBusyRef.current = true;
    try {
      const buffer = concatFloat32(liveChunksRef.current);
      const paused = tailRms(buffer, LIVE_TAIL_SAMPLES) < LIVE_SILENCE_RMS;
      const force = buffer.length > LIVE_MAX_SAMPLES;
      if (!paused && !force) return; // still speaking — keep buffering
      // Consume the buffer now; frames arriving during transcription land in a
      // fresh buffer and are handled next tick.
      liveChunksRef.current = [];
      liveLenRef.current = 0;
      const segs = segmentSpeech(buffer, SAMPLE_RATE);
      if (segs.length === 0) return; // pure silence — nothing to transcribe
      const text = await transcribeInWorker(concatFloat32(segs.map((s) => s.audio)));
      appendText(text);
    } catch {
      // transient (e.g. a dropped segment) — next tick continues
    } finally {
      liveBusyRef.current = false;
    }
  }, [transcribeInWorker, appendText]);

  const stopLiveLoop = useCallback(() => {
    if (liveTimerRef.current != null) {
      window.clearInterval(liveTimerRef.current);
      liveTimerRef.current = null;
    }
  }, []);

  const clearElapsedTimer = useCallback(() => {
    if (elapsedTimerRef.current != null) {
      window.clearInterval(elapsedTimerRef.current);
      elapsedTimerRef.current = null;
    }
  }, []);

  // ---- public controls ----
  const startLive = useCallback(() => {
    modeRef.current = "live";
    liveActiveRef.current = true;
    liveChunksRef.current = [];
    liveLenRef.current = 0;
    setLiveActive(true);
    loadModel();
    if (liveTimerRef.current == null) {
      liveTimerRef.current = window.setInterval(() => void runLiveTick(), LIVE_TICK_MS);
    }
  }, [loadModel, runLiveTick]);

  const stopLive = useCallback(() => {
    liveActiveRef.current = false;
    setLiveActive(false);
    stopLiveLoop();
    liveChunksRef.current = [];
    liveLenRef.current = 0;
  }, [stopLiveLoop]);

  const startRecording = useCallback(() => {
    modeRef.current = "record";
    recordingRef.current = true;
    recordChunksRef.current = [];
    setRecording(true);
    recordStartRef.current = Date.now();
    setElapsedMs(0);
    clearElapsedTimer();
    elapsedTimerRef.current = window.setInterval(
      () => setElapsedMs(Date.now() - recordStartRef.current),
      200,
    );
    loadModel();
  }, [loadModel, clearElapsedTimer]);

  const pauseRecording = useCallback(async () => {
    recordingRef.current = false;
    setRecording(false);
    clearElapsedTimer();
    const audio = concatFloat32(recordChunksRef.current);
    recordChunksRef.current = [];
    if (audio.length === 0) return;
    setTranscribing(true);
    try {
      const segs = segmentSpeech(audio, SAMPLE_RATE);
      const list = segs.length ? segs : [{ audio }];
      for (const s of list) {
        appendText(await transcribeInWorker(s.audio, RECORD_CHUNK_S));
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setTranscribing(false);
    }
  }, [clearElapsedTimer, transcribeInWorker, appendText]);

  const setMode = useCallback(
    (m: TranscribeMode) => {
      // Stop whatever's running before switching modes.
      liveActiveRef.current = false;
      setLiveActive(false);
      stopLiveLoop();
      recordingRef.current = false;
      setRecording(false);
      clearElapsedTimer();
      liveChunksRef.current = [];
      liveLenRef.current = 0;
      recordChunksRef.current = [];
      modeRef.current = m;
      setModeState(m);
    },
    [stopLiveLoop, clearElapsedTimer],
  );

  const reset = useCallback(() => setTranscript(""), []);

  const pushFrame = useCallback((frame: DecodedAudioFrame) => {
    // Agent guarantees 16 kHz mono; ignore anything else rather than mis-rate it.
    if (frame.sampleRate !== SAMPLE_RATE || frame.channels !== 1) return;
    const samples = pcmS16ToFloat32(frame.payload);
    if (modeRef.current === "live" && liveActiveRef.current) {
      liveChunksRef.current.push(samples);
      liveLenRef.current += samples.length;
    } else if (modeRef.current === "record" && recordingRef.current) {
      recordChunksRef.current.push(samples);
    }
  }, []);

  // Terminate the worker + timers on unmount.
  useEffect(() => {
    return () => {
      stopLiveLoop();
      clearElapsedTimer();
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, [stopLiveLoop, clearElapsedTimer]);

  return {
    status,
    progress,
    device,
    error,
    transcript,
    reset,
    mode,
    setMode,
    liveActive,
    startLive,
    stopLive,
    recording,
    transcribing,
    elapsedMs,
    startRecording,
    pauseRecording,
    pushFrame,
  };
}
