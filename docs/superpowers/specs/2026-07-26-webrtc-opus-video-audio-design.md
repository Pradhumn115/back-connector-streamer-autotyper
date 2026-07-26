# WebRTC (Opus + H264) video/audio transport — design

Date: 2026-07-26
Status: approved, pending implementation plan

## Context

Today the agent streams video as JPEG frames over the WSS control socket
(`FfmpegCapture` → `encodeFrame`) and, when transcription is on, system audio as
raw 16 kHz mono PCM over the same socket (`AudioCapture` → `encodeAudioFrame`).
This is simple and robust but not low-latency (see README "If video mode feels
laggy"). The client's Whisper-based transcription
(`useAudioTranscription`/`transcriberWorker`) already works well against the PCM
stream and is unaffected in its internals by this change.

This spec adds a second, switchable transport — WebRTC carrying an H264 video
track and an Opus audio track — alongside the existing one ("Classic"), without
replacing it.

## Goals

- A new "WebRTC" transport mode the client can toggle to, offering
  lower-latency video and enabling real-time audio *playback* (new capability —
  today audio is only ever transcribed, never played back) plus transcription
  fed from the same WebRTC audio track.
- Classic mode (JPEG/PCM over WSS) keeps working unchanged and remains the
  default. It's the only transport used for Cloudflare Tunnel connections.
- Control (mouse/keyboard/autotype/input-lock/diagnostics) stays on the
  existing WSS connection in **both** modes. Only one control implementation
  ever exists.
- No relay/TURN server. WebRTC mode is only offered on LAN/Tailscale, where
  direct ICE connectivity is expected to work without one — consistent with
  the project's "no relay server, no VPS" principle.

## Non-goals

- Making WebRTC work over a Cloudflare Tunnel (would require a TURN relay;
  explicitly out of scope, contradicts the project's no-relay-server design).
- Moving control messages onto a WebRTC data channel (considered and rejected
  — see trade-off below).
- Removing or deprecating the Classic transport.

## Trade-off: control channel stays on WSS

WebRTC media (and a WebRTC data channel, which needs the same ICE
connectivity) only works where direct UDP connectivity exists — LAN/Tailscale.
Over a Cloudflare Tunnel neither works. Putting control on a data channel would
therefore require **two independent, fully-featured control implementations**
(mouse/keyboard/autotype/lock/diagnostics) — one over WSS for Tunnel
connections, one over a data channel for LAN/Tailscale — roughly doubling that
surface area for no real latency benefit (control messages are tiny; WSS
round-trip latency on LAN/Tailscale is already sub-frame). Decision: control
always uses WSS, in every mode.

## Architecture

```
                      wss:// (unchanged)
  client  <──────────────────────────────────────>  agent
     │      auth, mouse/key/autotype/lock/diag,          │
     │      classic JPEG video + PCM audio frames,        │
     │      WebRTC SDP/ICE signaling (new message types)  │
     │                                                     │
     └───────────────── RTCPeerConnection ─────────────────┘
            (LAN/Tailscale only; H264 video + Opus audio)
```

Exactly one of Classic / WebRTC media is active at a time per session; the
agent stops one capture pipeline before starting the other.

## Wire protocol changes (`shared/src/messages.ts`)

New Zod-validated JSON message types, sent over the existing WSS text-message
path (no new binary framing — media never touches this socket):

**Client → agent:**
- `startWebrtc` — request the agent begin a WebRTC session.
- `stopWebrtc` — end it; agent reverts to no active media until Classic
  `setMode`/`setAudio` or another `startWebrtc` is sent.
- `webrtcAnswer { sdp }`
- `webrtcIceCandidate { candidate }`

**Agent → client:**
- `webrtcOffer { sdp }` — sent after `startWebrtc`, once the agent's
  `RTCPeerConnection` and both tracks are ready.
- `webrtcIceCandidate { candidate }`
- `webrtcState { active: boolean, error?: string }` — mirrors the
  `audioState`/`inputLockState` pattern: always reports the true state,
  including connection failures, never a silent no-op.

The agent initiates the offer (agent has the tracks). Existing `setMode`/
`setAudio` messages become no-ops while WebRTC is active (agent ignores them,
matching the "only one active pipeline" rule); the client's UI disables the
Classic-only controls while WebRTC is selected.

## Agent changes

New `agent/src/webrtc/` module:

- `WebrtcSession` — owns one `werift` `RTCPeerConnection` for the lifetime of
  a WebRTC-mode session (created on `startWebrtc`, closed on `stopWebrtc` or
  disconnect). Creates a video `MediaStreamTrack` (H264) and audio
  `MediaStreamTrack` (Opus), builds the offer, forwards ICE candidates.
- `RtpRelay` (video and audio each get one) — spawns `ffmpeg` with an RTP-muxer
  output encoding to H264 / Opus respectively, listens on a local UDP port for
  the packetized RTP, and calls `track.writeRtp(packet)` for each one. Reuses
  the existing device-detection code unchanged:
  - Video: same screen-capture input selection as `FfmpegCapture`
    (`display.ts` device logic), new output args (`-c:v libx264 -f rtp`).
  - Audio: same loopback device detection as `AudioCapture` (`audio/detect.ts`),
    new output args (`-c:a libopus -f rtp`).
- `ConnectionServer` (`connection/index.ts`) gains handlers for the four new
  message types and mode-exclusivity logic: `startWebrtc` stops
  `capture`/`audio` (Classic) if running and starts a `WebrtcSession`;
  `setMode`/`setAudio` while a `WebrtcSession` is active are ignored with a
  `webrtcState`/`agentError` clarifying why, not silently dropped.

New dependency: `werift` (pure TypeScript, no native build — consistent with
the project's easy-install philosophy).

## Client changes

- `client/src/webrtc/useWebrtcConnection.ts` — new hook. Given the `send`/
  message-handling surface already exposed by `useConnection`, it creates a
  browser `RTCPeerConnection`, handles the incoming offer, answers, exchanges
  ICE candidates, and exposes the resulting inbound `MediaStream` plus
  connection state. `useConnection` routes the four new agent→client message
  types to it (same pattern as `audioState`/`inputLockState` today).
- `ScreenView.tsx` — new Classic/WebRTC transport toggle next to the existing
  Screenshot/Video mode toggle. In WebRTC mode, the video track renders into a
  `<video autoplay playsinline>` element instead of the canvas/JPEG-blob path.
  `mapCoords.ts` is generalized to accept anything exposing
  `clientWidth`/`clientHeight` (both `<canvas>` and `<video>` already do) —
  a small adapter, not a rewrite.
- Audio playback: the inbound audio track is attached to a hidden `<audio>`
  element for real-time playback — new capability, since Classic mode never
  supported listening, only transcribing.
- Transcription adapter (`client/src/webrtc/webrtcAudioTap.ts`): taps the
  inbound audio `MediaStreamTrack` via Web Audio
  (`MediaStreamAudioSourceNode` → `AudioWorkletNode`), resamples from the
  track's native rate (browsers commonly render Opus decode at 48 kHz) to
  16 kHz mono, and calls into `useAudioTranscription` through the same
  frame-shaped interface `pushFrame` already accepts — so VAD/Whisper worker
  code in `useAudioTranscription`/`transcriberWorker` is untouched, only the
  PCM source changes.
- Toggle gating: the WebRTC option is only enabled when the active connection
  target is LAN or Tailscale (the client already knows which target index
  succeeded in `useConnection`); disabled with an explanatory tooltip for
  Tunnel connections.
- Failure handling: if ICE doesn't reach `connected` within 5s of receiving
  the offer, the hook reports failure, the UI reverts the toggle to Classic
  and surfaces the error — no silent fallback.

## Testing plan

- `shared`: unit tests for the four new message schemas (parse/round-trip),
  following the existing pattern for other message types.
- `agent`: integration test for `WebrtcSession` + `RtpRelay` against a stub/
  local loopback (mirrors `connection.integration.test.ts` and
  `audio/detect.test.ts` style) verifying: offer is produced once tracks are
  ready, mode-exclusivity (starting WebRTC stops Classic capture and vice
  versa), and clean teardown on `stopWebrtc`/disconnect.
- `npm run typecheck` / `npm test` across workspaces as usual.
- **Manual, end-to-end, in a real Chrome browser** (agent and client on the
  same LAN-reachable machine for this session): run the agent, open the
  client in Chrome via the browser automation tools, connect, toggle WebRTC
  mode on, and verify: video renders in the `<video>` element, audio is
  audible, mouse/keyboard control still works (proving the WSS control path is
  unaffected), live transcription produces text sourced from the WebRTC audio
  tap, and toggling back to Classic mode cleanly reverts. Console/network
  logs inspected for WebRTC connection errors along the way.

## Open questions / risks

- `werift`'s external-RTP-injection API (`writeRtp` on a track from packets
  produced by an outside encoder) is the intended integration point per its
  docs, but exact API surface should be confirmed against the installed
  version during implementation — flag as a first implementation-plan step to
  verify before building the rest of `RtpRelay` on top of it.
- H264 requires ffmpeg built with an H264 encoder (`libx264` or platform
  hardware encoder) — `npm run setup`'s ffmpeg install should be checked to
  confirm this is included by default per OS; if not, the plan should add it.
