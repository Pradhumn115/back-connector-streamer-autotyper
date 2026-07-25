# System-audio capture → in-browser transcription — design

## Goal

Let the client see a **live text transcript of whatever audio is playing on the
agent machine** (system output / loopback), with no server, no API keys, and no
audio leaving the client. Audio is a means to text only — there is **no
client-side playback**.

## Decisions (locked)

- **Capture:** system output loopback via ffmpeg, emitted as **16 kHz mono
  s16le PCM** (Whisper's native input format).
- **Transport:** new binary `BCAF` audio frames over the existing WebSocket,
  alongside the `BCSF` video frames.
- **Transcription:** **Whisper in the browser** via `@huggingface/transformers`
  (`onnx-community/whisper-base.en`), WebGPU with a WASM fallback, running in a
  **Web Worker**. Verified viable: WebGPU is 5–10× WASM and transcribes
  ~5–8× real-time without blocking the UI (ref: Xenova/realtime-whisper-webgpu).
- **Loopback device install:** automated in `npm run setup` per-OS, with honest
  runtime detection (`supported:false` when absent).

## Non-goals (YAGNI)

- No audio playback on the client.
- No cloud STT, no API keys.
- No speaker diarization, translation, or punctuation post-processing (Whisper's
  own output is enough for v1).

## Components

### 1. Shared protocol (`shared/`)

New `frame-audio.ts` (parallel to `frame.ts`):

- Magic `BCAF` = `0x42434146`. Header (little-endian):
  `magic u32 · seq u32 · timestamp f64 · sampleRate u32 · channels u8 ·
  format u8 (0 = PCM s16le) · reserved u16`, then PCM payload.
- `encodeAudioFrame`, `decodeAudioFrame`, `isAudioFrame`.
- `isFrame` (video) and `isAudioFrame` (audio) are mutually exclusive magic
  checks, so the client's binary `onmessage` routes on magic — no other
  transport change.

New control messages in `messages.ts`:

- `SetAudioMessage` (client→agent): `{ type: "setAudio", enabled: boolean }`.
- `AudioStateMessage` (agent→client):
  `{ type: "audioState", enabled: boolean, supported: boolean }`
  — `supported` mirrors `inputLockState.supported` so the client can disable the
  toggle honestly.
- Add both to the discriminated unions + parsers.

### 2. Agent (`agent/src/audio/`)

- `AudioCapture` (interface parallel to `ScreenCapture`): `start(handler)`,
  `stop()`, `supported`. One long-lived ffmpeg process:
  `ffmpeg -f <os-input> -i <loopback-device> -ac 1 -ar 16000 -f s16le pipe:1`,
  read in ~100 ms chunks (3200 bytes) and emitted as `BCAF` frames with a
  monotonic seq + timestamp.
- `detectLoopbackDevice()` per OS (pure parser over `ffmpeg -list_devices` /
  known names), returns `{ device, supported }`:
  - **linux:** `-f pulse -i @DEFAULT_MONITOR@` — the PulseAudio special token for
    the default sink's monitor (works under PipeWire too, which emulates Pulse).
    `default.monitor` is NOT a real device name; if the token ever fails, resolve
    it explicitly via `pactl get-default-sink` + `.monitor`. `supported` = `pactl`
    exists and returns a default sink.
  - **macOS:** avfoundation audio device named **BlackHole** → `:<index>`.
  - **windows:** dshow **virtual-audio-capturer** or a VB-Cable output.
- `ConnectionServer`: handle `setAudio` (start/stop `AudioCapture`, stream its
  frames to the single controller), send `audioState` right after auth (like the
  initial `inputLockState`), and stop audio on disconnect/close. Errors starting
  capture are reported via `agentError` + `audioState{enabled:false}` — never a
  silent no-op.

### 3. Client (`client/src/audio/`)

- `transcriberWorker.ts` — a Web Worker that lazy-loads the ASR pipeline
  (`pipeline("automatic-speech-recognition", "onnx-community/whisper-base.en",
  { device: "webgpu" | "wasm", dtype })`), receives Float32Array windows, posts
  back `{ text }`. Loading/model-download progress is posted so the UI can show
  a "loading model…" state. Model weights are fetched from the HF CDN by the
  client's own browser (not through the tunnel) and cached in-browser.
- `useAudioTranscription.ts` — accepts incoming `BCAF` frames, converts s16→
  Float32 (`/32768`), accumulates a rolling **~5 s window with ~1 s overlap**,
  and dispatches each window to the worker; appends returned text to a running
  transcript (dedup the overlap region). Exposes `{ supported, enabled,
  modelStatus, transcript, setEnabled }`.
- `useConnection.ts`: in the binary `onmessage`, route `isAudioFrame` → the
  transcription hook, else the existing video path. Add `audio` state,
  `setAudio` send, and `audioState` handling.
- `App.tsx`: a **"Transcribe audio"** toggle card in the side panel — disabled
  with a "loopback device needed on the agent" hint when `supported:false`, and
  showing model-load status. The toggle click is the user gesture that also
  triggers worker/model init. Below it, a scrolling **live transcript** area.

### 4. Setup (`scripts/setup.mjs`)

Extend per-OS (all confirmed automatable via package managers):
- **macOS:** `brew install blackhole-2ch` (official Homebrew cask). Print the
  manual step (create a Multi-Output Device in Audio MIDI Setup so the user both
  hears audio and routes it to BlackHole) — this cannot be automated.
- **Windows:** `choco install vb-cable` (Chocolatey community package). Note it
  may require a reboot / driver-signature approval before the device appears;
  document that. (No reliable winget package for VB-Cable, so prefer choco;
  fall back to a documented manual download.)
- **Linux:** nothing to install — uses the existing PulseAudio/PipeWire monitor.

### 5. Dependencies

- Client: add `@huggingface/transformers`. Lazy-loaded so it doesn't bloat the
  initial bundle; the model weights load on first enable.

## Data flow

```
ffmpeg loopback ─PCM s16 16k mono─► AudioCapture ─BCAF frames─► ws
  ─► client onmessage (isAudioFrame) ─► s16→f32, 5s rolling window
  ─► Web Worker: Whisper(webgpu) ─► text ─► appended transcript in panel
```

## Failure / edge handling

- No loopback device → `supported:false` → toggle disabled + hint. Never streams
  silence pretending to work.
- No WebGPU → fall back to WASM (`dtype:"q8"`), slower but functional; surface a
  "using CPU (slower)" note.
- Model download offline/blocked → worker posts an error → toggle shows "model
  failed to load", transcription stays off.
- Agent audio start failure (ffmpeg/device error) → `agentError` +
  `audioState{enabled:false}`.

## Testing

- **shared:** `encodeAudioFrame`/`decodeAudioFrame` round-trip; `isAudioFrame`
  vs `isFrame` mutual exclusivity on both frame types.
- **agent:** `detectLoopbackDevice()` pure-parser tests over sample
  `ffmpeg -list_devices` output for each OS (found / not-found).
- **client:** s16→Float32 conversion is a pure function → unit test; window/
  overlap accumulation logic tested with synthetic frames. Worker + WebGPU
  transcription itself is validated manually (not unit-tested).
- Manual E2E: play audio on the agent, enable transcribe, confirm captions.

## Rollout notes

- Bandwidth: 16 kHz mono s16 ≈ 256 kbps — small next to the MJPEG video, fine
  over the tunnel.
- Latency: ~5 s window → captions lag a few seconds; acceptable for v1. A
  silero-VAD segmenter (cut on silence) is the documented improvement path.
- Privacy: audio → text happens entirely in the client browser; nothing is sent
  to any third party. Model weights are the only external fetch (HF CDN), one
  time.

## Validation (web-confirmed 2026-07)

- In-browser Whisper on WebGPU is production-viable: 5–10× faster than WASM,
  ~5–8× real-time on whisper-base without blocking the UI (runs in a worker).
  Reference: Xenova/realtime-whisper-webgpu, xenova/whisper-web. transformers.js
  API confirmed: `pipeline("automatic-speech-recognition",
  "onnx-community/whisper-base.en", { device: "webgpu" })`, input Float32Array
  @16 kHz mono. WebGPU needs Chrome/Edge 113+.
- Loopback install automatable: `brew install blackhole-2ch` (mac cask),
  `choco install vb-cable` (Windows). Linux uses `ffmpeg -f pulse -i
  @DEFAULT_MONITOR@` (PipeWire-compatible).
