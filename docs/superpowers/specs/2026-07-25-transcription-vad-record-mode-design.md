# Transcription v2 — VAD + Live/Record modes — design

## Goals

1. **Record mode:** a Record/Pause control. While recording, buffer the agent's
   audio; on **pause**, transcribe the whole take at once (full context, cleanest
   result). This is "record for a while, pause, then transcribe that".
2. **Fix live mode with VAD:** gate Whisper behind Silero VAD so silence never
   reaches the model (kills the stray "you" hallucinations) and utterances are
   cut on pauses, not arbitrary 5 s windows (kills repetition).

Model stays **whisper-base.en** (fp32 on WebGPU, q8 on WASM) — proven working.
Research: VAD→ASR is the standard fix for silence/hallucination; Silero is the
de-facto browser VAD (needs 16 kHz mono, which we already produce).

## Approach

A single `Segmenter` boundary (`client/src/audio/vad.ts`) wraps **Silero VAD**
(`@ricky0123/vad-web` `NonRealTimeVAD`) and returns speech segments from a
Float32 buffer. **Graceful degradation:** if VAD fails to load, `segmentSpeech`
returns the whole buffer as one segment, so transcription still works (just
without silence-trimming) rather than breaking.

Both modes feed VAD-produced speech segments to the existing Whisper worker.

### Live mode (VAD-gated streaming)
- Accumulate incoming PCM in a rolling buffer.
- On a ~1.2 s cadence (while ready), run VAD over the buffer. When speech is
  followed by trailing silence (utterance complete), transcribe the trimmed
  speech and append; drop the consumed audio, keep any trailing partial speech.
- Force-flush if the buffer grows beyond ~25 s; clear pure silence beyond ~2 s.

### Record mode (buffer → transcribe on pause)
- **Record:** clear buffer, `conn.setAudio(true)`, append all frames; show
  elapsed time. No transcription while recording.
- **Pause:** `conn.setAudio(false)`, run VAD over the full take, transcribe each
  speech segment in order (Whisper long-form `chunk_length_s: 30` for long
  segments), join into the transcript. Status shows "transcribing…".

## Components

- `client/src/audio/vad.ts` — lazy Silero VAD; `segmentSpeech(f32, 16000) →
  {start,end,audio}[]`; fallback to `[whole]` on load failure. Pure helpers
  (`concatFloat32`, silence math) unit-tested.
- `client/src/audio/useAudioTranscription.ts` — gains `mode: 'live'|'record'`,
  `setMode`, `recording`, `elapsedMs`, `startRecording`, `pauseRecording`;
  keeps `start/stop/pushFrame/reset` for live. VAD wired into both paths.
- `client/src/audio/transcriberWorker.ts` — `transcribe` message gains optional
  `chunkLengthS` passed to the pipeline for long record segments.
- `client/src/App.tsx` — transcribe card gains a **[Live | Record]** segmented
  control; Live shows the existing toggle, Record shows **⏺ Record / ⏸ Pause**
  + elapsed timer. Shared transcript panel below.
- Dependency: `@ricky0123/vad-web` (+ `onnxruntime-web`), lazy-loaded.

## Testing

- Unit: `concatFloat32`, buffer-trim/segment-selection helpers, s16→f32 (exists).
- Manual/browser E2E: play speech with pauses → live shows clean utterances, no
  stray "you"; Record a take, pause → whole take transcribed once.
- VAD-load-failure path: falls back to whole-buffer transcription (no crash).

## Out of scope (YAGNI)

- Moonshine / turbo model swaps (documented as options; base.en stays).
- Speaker diarization, timestamps, punctuation post-processing.
- Per-segment re-transcription/streaming token revision.
