import { useCallback, useEffect, useRef, useState } from "react";
import type { DecodedAudioFrame } from "@bcsa/shared";
import { pcmS16ToFloat32 } from "./pcm";
import { chunkDuration, scheduleChunk } from "./jitter";

/**
 * Plays the agent's system audio in the browser.
 *
 * ## Why this did not already exist
 *
 * The agent has always captured system audio and streamed it as PCM, and the
 * client has always decoded those frames — straight into the transcriber. The
 * sound arrived and was turned into text, and the audio itself was discarded.
 * Everything except the last step was already built.
 *
 * ## Why listening is separate from transcribing
 *
 * They are different jobs. Transcription wants 16 kHz mono and does not care
 * whether a human hears it; listening wants to hear the machine and does not
 * care whether anything is written down. Tying them together would mean
 * captions you cannot silence and audio you cannot have without running a
 * speech model. So both are toggles, and the agent's capture runs whenever
 * either wants it.
 *
 * ## Latency
 *
 * Chunks are queued a little ahead of playback rather than played on arrival —
 * see jitter.ts, which owns that reasoning. The default target is 150 ms:
 * enough to absorb ordinary network variation, small enough that the sound
 * still belongs to the picture.
 */
export type PlaybackStatus = "idle" | "running" | "blocked" | "unsupported";

export interface UseAudioPlayback {
  enabled: boolean;
  status: PlaybackStatus;
  /** 0..1. */
  volume: number;
  setVolume: (v: number) => void;
  /** Must be called from a user gesture; browsers block audio otherwise. */
  setEnabled: (on: boolean) => void;
  /** Times the schedule was reset — a dropout counter worth surfacing. */
  resyncs: number;
  error: string | null;
  pushFrame: (frame: DecodedAudioFrame) => void;
}

/** Deliberate delay held to absorb network jitter, in seconds. */
const TARGET_LATENCY_S = 0.15;
/** Queue depth past which the delay is treated as runaway and trimmed. */
const MAX_LATENCY_S = 0.6;

type AudioContextCtor = typeof AudioContext;

export function useAudioPlayback(): UseAudioPlayback {
  const [enabled, setEnabledState] = useState(false);
  const [status, setStatus] = useState<PlaybackStatus>("idle");
  const [volume, setVolumeState] = useState(1);
  const [resyncs, setResyncs] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const ctxRef = useRef<AudioContext | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  /** End of the last scheduled chunk, in context time. */
  const nextTimeRef = useRef(0);
  const enabledRef = useRef(false);
  enabledRef.current = enabled;

  const teardown = useCallback(() => {
    nextTimeRef.current = 0;
    gainRef.current = null;
    const ctx = ctxRef.current;
    ctxRef.current = null;
    if (ctx) void ctx.close().catch(() => {});
  }, []);

  useEffect(() => teardown, [teardown]);

  const setEnabled = useCallback(
    (on: boolean) => {
      setError(null);
      if (!on) {
        setEnabledState(false);
        setStatus("idle");
        teardown();
        return;
      }

      const Ctor: AudioContextCtor | undefined =
        globalThis.AudioContext ??
        (globalThis as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext;
      if (!Ctor) {
        setStatus("unsupported");
        setError("This browser has no Web Audio support.");
        return;
      }

      try {
        const ctx = new Ctor();
        const gain = ctx.createGain();
        gain.gain.value = volume;
        gain.connect(ctx.destination);
        ctxRef.current = ctx;
        gainRef.current = gain;
        nextTimeRef.current = 0;
        // Per listening session: a count carried over from a previous one would
        // describe a stream that is no longer playing.
        setResyncs(0);
        setEnabledState(true);

        // Contexts start suspended unless created inside a user gesture. This
        // call is made from the toggle's click for exactly that reason, but a
        // browser may still refuse, and silent audio with no explanation is
        // the worst outcome — so a refusal becomes a reported state.
        void ctx
          .resume()
          .then(() => setStatus(ctx.state === "running" ? "running" : "blocked"))
          .catch(() => {
            setStatus("blocked");
            setError("The browser blocked audio playback. Interact with the page and retry.");
          });
      } catch (err) {
        setStatus("unsupported");
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [teardown, volume],
  );

  const setVolume = useCallback((v: number) => {
    const clamped = Math.min(1, Math.max(0, v));
    setVolumeState(clamped);
    if (gainRef.current) gainRef.current.gain.value = clamped;
  }, []);

  const pushFrame = useCallback((frame: DecodedAudioFrame) => {
    const ctx = ctxRef.current;
    const gain = gainRef.current;
    if (!enabledRef.current || !ctx || !gain || ctx.state === "closed") return;

    const samples = pcmS16ToFloat32(frame.payload);
    const channels = Math.max(1, frame.channels);
    const duration = chunkDuration(samples.length, frame.sampleRate, channels);
    if (duration <= 0) return;

    // The buffer carries the agent's sample rate rather than the context's, and
    // the browser resamples on playback. Forcing a context rate instead would
    // fail wherever 16 kHz is not an allowed rate.
    const frameCount = Math.floor(samples.length / channels);
    let buffer: AudioBuffer;
    try {
      buffer = ctx.createBuffer(channels, frameCount, frame.sampleRate);
    } catch {
      // An unsupported rate or channel count; drop the chunk rather than throw
      // inside the socket's message handler.
      return;
    }
    for (let c = 0; c < channels; c++) {
      const channel = buffer.getChannelData(c);
      for (let i = 0; i < frameCount; i++) channel[i] = samples[i * channels + c];
    }

    const schedule = scheduleChunk(
      nextTimeRef.current,
      ctx.currentTime,
      duration,
      TARGET_LATENCY_S,
      MAX_LATENCY_S,
    );
    nextTimeRef.current = schedule.nextTime;
    if (schedule.resynced) setResyncs((n) => n + 1);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(gain);
    source.start(schedule.startAt);
  }, []);

  return { enabled, status, volume, setVolume, setEnabled, resyncs, error, pushFrame };
}
