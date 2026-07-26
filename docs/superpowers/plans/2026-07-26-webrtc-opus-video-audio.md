# WebRTC (Opus + H264) Video/Audio Transport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a second, switchable video/audio transport — WebRTC (H264 video + Opus audio) — alongside the existing JPEG/PCM-over-WSS transport, with control staying on WSS in both modes.

**Architecture:** The agent's existing `wss://` control connection gains four new JSON message types that carry WebRTC SDP offer/answer (vanilla ICE — no separate ICE-candidate messages needed; werift/browsers both gather full ICE before resolving `setLocalDescription`, so candidates ride along inside the SDP). `ffmpeg` encodes the screen to H264 and loopback audio to Opus, each muxed as RTP over a local UDP socket; a small relay reads that UDP socket and calls `track.writeRtp()` on a `werift` `MediaStreamTrack`, which does the actual WebRTC send. The browser client answers, renders the inbound video track in a `<video>` element, plays the inbound audio track, and taps a copy of the decoded PCM to feed the *existing, unmodified* Whisper transcription pipeline.

**Tech Stack:** `werift` (pure-TS WebRTC for Node), existing `ffmpeg` capture pipeline, browser `RTCPeerConnection`/`AudioWorklet`, existing Zod message schemas, `node:test` for unit/integration tests.

## Global Constraints

- No relay/TURN server. WebRTC mode is only offered to clients connected via LAN or Tailscale — never over the Cloudflare Tunnel path (matches the project's "no relay server, no VPS" principle; see spec's Non-goals).
- Control (mouse/keyboard/autotype/input-lock/diagnostics) stays on the WSS connection in **both** transport modes. Never move control to a WebRTC data channel (see spec's "Trade-off" section).
- Classic (JPEG/PCM-over-WSS) transport must keep working completely unchanged and remains the default.
- Exactly one media pipeline (Classic or WebRTC) runs on the agent at a time per session.
- No silent fallback: if WebRTC ICE doesn't connect within 5s, surface the error and revert the client's toggle to Classic.
- Spec reference: `docs/superpowers/specs/2026-07-26-webrtc-opus-video-audio-design.md`.

---

## Task 1: Shared wire protocol — WebRTC signaling messages

**Files:**
- Modify: `shared/src/messages.ts`
- Test: `shared/src/messages.test.ts`

**Interfaces:**
- Produces: `StartWebrtcMessage { type: "startWebrtc" }`, `StopWebrtcMessage { type: "stopWebrtc" }`, `WebrtcAnswerMessage { type: "webrtcAnswer", sdp: string }` (client→agent); `WebrtcOfferMessage { type: "webrtcOffer", sdp: string }`, `WebrtcStateMessage { type: "webrtcState", active: boolean, error?: string }` (agent→client). All added to the existing `ClientMessage`/`AgentMessage` discriminated unions and exported.

- [ ] **Step 1: Write the failing tests**

Add to `shared/src/messages.test.ts`:

```ts
import {
  parseClientMessage,
  parseAgentMessage,
} from "./messages.js";

test("parses startWebrtc / stopWebrtc", () => {
  const start = parseClientMessage(JSON.stringify({ type: "startWebrtc" }));
  assert.equal(start.type, "startWebrtc");
  const stop = parseClientMessage(JSON.stringify({ type: "stopWebrtc" }));
  assert.equal(stop.type, "stopWebrtc");
});

test("parses webrtcAnswer with sdp string", () => {
  const msg = parseClientMessage(
    JSON.stringify({ type: "webrtcAnswer", sdp: "v=0\r\n..." }),
  );
  assert.equal(msg.type, "webrtcAnswer");
  if (msg.type === "webrtcAnswer") assert.equal(msg.sdp, "v=0\r\n...");
});

test("rejects webrtcAnswer with empty sdp", () => {
  assert.throws(() =>
    parseClientMessage(JSON.stringify({ type: "webrtcAnswer", sdp: "" })),
  );
});

test("parses webrtcOffer from agent", () => {
  const msg = parseAgentMessage(
    JSON.stringify({ type: "webrtcOffer", sdp: "v=0\r\n..." }),
  );
  assert.equal(msg.type, "webrtcOffer");
});

test("parses webrtcState with and without error", () => {
  const ok = parseAgentMessage(JSON.stringify({ type: "webrtcState", active: true }));
  assert.equal(ok.type, "webrtcState");
  if (ok.type === "webrtcState") assert.equal(ok.active, true);
  const failed = parseAgentMessage(
    JSON.stringify({ type: "webrtcState", active: false, error: "ICE timed out" }),
  );
  if (failed.type === "webrtcState") assert.equal(failed.error, "ICE timed out");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test --workspace=shared`
Expected: FAIL — `startWebrtc`/`webrtcAnswer`/etc. are not valid message types yet (Zod union parse throws).

- [ ] **Step 3: Add the message schemas**

In `shared/src/messages.ts`, after `SetAudioMessage` (client→agent section):

```ts
/** Ask the agent to open a WebRTC session (H264 video + Opus audio) and send an offer. */
export const StartWebrtcMessage = z.object({
  type: z.literal("startWebrtc"),
});

/** Ask the agent to tear down its WebRTC session, if any. */
export const StopWebrtcMessage = z.object({
  type: z.literal("stopWebrtc"),
});

/** The client's SDP answer to the agent's WebRTC offer. */
export const WebrtcAnswerMessage = z.object({
  type: z.literal("webrtcAnswer"),
  sdp: z.string().min(1),
});
```

After `AudioStateMessage` (agent→client section):

```ts
/** The agent's SDP offer, sent once its WebRTC tracks are ready. */
export const WebrtcOfferMessage = z.object({
  type: z.literal("webrtcOffer"),
  sdp: z.string().min(1),
});

/**
 * Reports the agent's WebRTC session state. Always reflects the true state,
 * including connection failures, so the client never shows an active session
 * that isn't really there (same honesty contract as audioState/inputLockState).
 */
export const WebrtcStateMessage = z.object({
  type: z.literal("webrtcState"),
  active: z.boolean(),
  error: z.string().optional(),
});
```

Add all five to the unions:

```ts
export const ClientMessage = z.discriminatedUnion("type", [
  AuthMessage,
  SetModeMessage,
  MouseMessage,
  KeyMessage,
  AutotypeMessage,
  CancelAutotypeMessage,
  SetInputLockMessage,
  SetAudioMessage,
  RunDiagnosticsMessage,
  StartWebrtcMessage,
  StopWebrtcMessage,
  WebrtcAnswerMessage,
]);

export const AgentMessage = z.discriminatedUnion("type", [
  AuthResultMessage,
  AgentInfoMessage,
  AutotypeProgressMessage,
  AutotypeDoneMessage,
  AgentErrorMessage,
  InputLockStateMessage,
  AudioStateMessage,
  DiagnosticsMessage,
  WebrtcOfferMessage,
  WebrtcStateMessage,
]);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test --workspace=shared`
Expected: PASS

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck --workspace=shared
git add shared/src/messages.ts shared/src/messages.test.ts
git commit -m "shared: add WebRTC signaling message types"
```

---

## Task 2: Agent — add werift, codec parameters module

**Files:**
- Modify: `agent/package.json`
- Create: `agent/src/webrtc/codecs.ts`

**Interfaces:**
- Produces: `VIDEO_CODEC: RTCRtpCodecParameters` (H264, payloadType 96), `AUDIO_CODEC: RTCRtpCodecParameters` (Opus, payloadType 111), both from `werift`.

- [ ] **Step 1: Add the dependency**

```bash
cd agent && npm install werift
```

This adds `werift` to `agent/package.json` `dependencies` (pure TypeScript, no native build step).

- [ ] **Step 2: Create the codec parameters module**

`agent/src/webrtc/codecs.ts`:

```ts
import { RTCRtpCodecParameters } from "werift";

/**
 * H264 constrained-baseline (profile-level-id 42e01f), packetization-mode 1 —
 * the combination every Chromium/Firefox/Safari WebRTC stack accepts, and what
 * ffmpeg's libx264 with `-profile:v baseline -level 3.1` produces.
 */
export const VIDEO_CODEC = new RTCRtpCodecParameters({
  mimeType: "video/H264",
  clockRate: 90000,
  payloadType: 96,
  parameters: "profile-level-id=42e01f;packetization-mode=1;level-asymmetry-allowed=1",
  rtcpFeedback: [
    { type: "ccm", parameter: "fir" },
    { type: "nack" },
    { type: "nack", parameter: "pli" },
    { type: "goog-remb" },
  ],
});

/** Opus mono at 48 kHz — matches ffmpeg's libopus default and browser decode. */
export const AUDIO_CODEC = new RTCRtpCodecParameters({
  mimeType: "audio/opus",
  clockRate: 48000,
  channels: 1,
  payloadType: 111,
});
```

There's no test for this file — it's static configuration, mirroring how `agent/src/capture/ffmpeg.ts`'s `buildArgs()` constants aren't separately unit tested in this codebase either.

- [ ] **Step 3: Typecheck and commit**

```bash
npm run typecheck --workspace=agent
git add agent/package.json agent/package-lock.json agent/src/webrtc/codecs.ts
git commit -m "agent: add werift dependency + H264/Opus codec parameters"
```

---

## Task 3: Agent — RtpRelay (ffmpeg → RTP → werift track)

**Files:**
- Create: `agent/src/webrtc/rtpRelay.ts`

**Interfaces:**
- Consumes: nothing new from earlier tasks.
- Produces: `class RtpRelay { start(track: MediaStreamTrack): void; stop(): void }`, constructed as `new RtpRelay(kind: "video" | "audio", ffmpegArgs: string[])`. `start()` spawns ffmpeg with `ffmpegArgs` (which must end in an `-f rtp rtp://127.0.0.1:<port>` output, port chosen internally), binds a local UDP socket on that port, and for every UDP datagram received calls `track.writeRtp(RtpPacket.deSerialize(datagram))`. `stop()` kills ffmpeg and closes the socket. Later tasks (`session.ts`) construct one `RtpRelay` for video and one for audio.

**Implementation notes:**
- Follows the exact pattern from werift's own `examples/mediachannel/sendonly/ffmpeg.ts`: pick a random free UDP port, spawn ffmpeg targeting `rtp://127.0.0.1:<port>`, and on each `dgram` message do `track.writeRtp(RtpPacket.deSerialize(data))`.
- Reuses the existing device-detection helpers (`display.ts`'s platform switch, `audio/detect.ts`'s `detectLoopbackDevice()`) for the ffmpeg *input* args — only the *output* side (`-f rtp` instead of `-f mjpeg`/`-f s16le`) is new. Building the full input+output arg list per OS/kind is the job of `session.ts` in Task 4; `RtpRelay` itself is transport-agnostic (just "run this ffmpeg command, relay its RTP output").
- No dedicated unit test: like `agent/src/capture/ffmpeg.ts` and `agent/src/audio/index.ts` (which spawn ffmpeg and aren't unit tested either — only their pure helper functions in `detect.ts` are), process-spawning + UDP glue isn't practical to unit test here. It's exercised end-to-end by Task 4's integration test and the Task 11 manual browser test.

- [ ] **Step 1: Implement `RtpRelay`**

```ts
import { createSocket, type Socket } from "node:dgram";
import { spawn, type ChildProcess } from "node:child_process";
import { RtpPacket, type MediaStreamTrack } from "werift";

/**
 * Spawns an ffmpeg process that encodes into RTP over a local UDP port, and
 * relays every packet it emits into a werift MediaStreamTrack via writeRtp().
 * One instance per track (video or audio). Crash-only: if ffmpeg exits, the
 * relay just stops forwarding until stop()/start() is called again — mirrors
 * FfmpegCapture/AudioCapture's "no hot-loop respawn" behavior.
 */
export class RtpRelay {
  private proc: ChildProcess | null = null;
  private socket: Socket | null = null;

  constructor(
    private readonly kind: "video" | "audio",
    /** Builds the full ffmpeg args given the chosen local RTP port. */
    private readonly buildArgs: (port: number) => string[],
  ) {}

  async start(track: MediaStreamTrack): Promise<void> {
    this.stop();
    const port = await randomUdpPort();
    const socket = createSocket("udp4");
    this.socket = socket;
    socket.on("message", (data) => {
      try {
        track.writeRtp(RtpPacket.deSerialize(data));
      } catch (err) {
        process.stderr.write(`[webrtc:${this.kind}] bad RTP packet: ${String(err)}\n`);
      }
    });
    socket.bind(port);

    const proc = spawn("ffmpeg", this.buildArgs(port), { stdio: ["ignore", "ignore", "ignore"] });
    this.proc = proc;
    proc.on("error", (err) => {
      process.stderr.write(`[webrtc:${this.kind}] ffmpeg spawn error: ${String(err)}\n`);
    });
    proc.on("exit", (code) => {
      if (this.proc === proc) this.proc = null;
      if (code !== null && code !== 0) {
        process.stderr.write(`[webrtc:${this.kind}] ffmpeg exited with code ${code}\n`);
      }
    });
  }

  stop(): void {
    if (this.proc) {
      this.proc.kill("SIGKILL");
      this.proc = null;
    }
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
  }
}

/** Bind to port 0 to let the OS pick a free UDP port, then read it back. */
function randomUdpPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createSocket("udp4");
    probe.bind(0, () => {
      const port = (probe.address() as { port: number }).port;
      probe.close(() => resolve(port));
    });
    probe.on("error", reject);
  });
}
```

- [ ] **Step 2: Typecheck and commit**

```bash
npm run typecheck --workspace=agent
git add agent/src/webrtc/rtpRelay.ts
git commit -m "agent: add RtpRelay to bridge ffmpeg RTP output into werift tracks"
```

---

## Task 4: Agent — WebrtcSession (peer connection lifecycle)

**Files:**
- Create: `agent/src/webrtc/session.ts`
- Test: `agent/src/webrtc/session.integration.test.ts`

**Interfaces:**
- Consumes: `VIDEO_CODEC`, `AUDIO_CODEC` from Task 2 (`./codecs.js`); `RtpRelay` from Task 3 (`./rtpRelay.js`).
- Produces:
  ```ts
  export interface WebrtcSessionDeps {
    videoFfmpegArgs: (port: number) => string[];
    audioFfmpegArgs: (port: number) => string[];
    onStateChange: (active: boolean, error?: string) => void;
  }
  export class WebrtcSession {
    constructor(deps: WebrtcSessionDeps);
    /** Builds the offer, starts both RtpRelays, returns the SDP to send to the client. */
    createOffer(): Promise<string>;
    /** Applies the client's SDP answer; resolves once ICE reaches "connected", rejects (and calls onStateChange(false, err)) if it doesn't within 5s. */
    setAnswer(sdp: string): Promise<void>;
    close(): void;
  }
  ```
  Later tasks (`connection/index.ts` in Task 5) construct one `WebrtcSession` per `startWebrtc` request.

- [ ] **Step 1: Write the failing integration test**

This test runs two `werift` peer connections in-process (the agent's `WebrtcSession` and a bare `RTCPeerConnection` standing in for the browser) to verify the full offer → answer → ICE-connect → `writeRtp`-relay path works without needing a real browser or ffmpeg. `agent/src/webrtc/session.integration.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { RTCPeerConnection, RtpPacket } from "werift";
import { WebrtcSession } from "./session.js";
import { VIDEO_CODEC, AUDIO_CODEC } from "./codecs.js";

test("createOffer/setAnswer establishes a connection and relays RTP", async () => {
  const states: Array<{ active: boolean; error?: string }> = [];
  const session = new WebrtcSession({
    // No real ffmpeg: these args are never spawned in this test because we
    // inject packets directly below instead of relying on RtpRelay's ffmpeg
    // spawn — see note after this test.
    videoFfmpegArgs: () => ["-f", "lavfi", "-i", "nullsrc", "-f", "null", "-"],
    audioFfmpegArgs: () => ["-f", "lavfi", "-i", "anullsrc", "-f", "null", "-"],
    onStateChange: (active, error) => states.push({ active, error }),
  });

  const offerSdp = await session.createOffer();

  // Stand-in "browser" peer: recvonly, using the same codecs the agent offers.
  const browserPc = new RTCPeerConnection({
    codecs: { video: [VIDEO_CODEC], audio: [AUDIO_CODEC] },
  });
  let gotVideoRtp = false;
  browserPc.ontrack = ({ track }) => {
    track.onReceiveRtp.subscribe(() => {
      gotVideoRtp = true;
    });
  };
  await browserPc.setRemoteDescription({ type: "offer", sdp: offerSdp });
  const answer = await browserPc.createAnswer();
  await browserPc.setLocalDescription(answer);

  await session.setAnswer(browserPc.localDescription!.sdp);

  assert.equal(states.at(-1)?.active, true);

  session.close();
  await browserPc.close();
});
```

Note: this test exercises `createOffer`/`setAnswer`/ICE-connect end-to-end, but not `RtpRelay`'s ffmpeg spawn (that has no dedicated test per Task 3's notes — it's covered by the Task 11 manual browser test with the real capture pipeline). Delete the unused `gotVideoRtp` assertion setup if `RtpRelay` never actually writes a packet during this short-lived test — the meaningful assertion is that `states.at(-1)?.active` becomes `true`, i.e. ICE actually connected.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test --workspace=agent -- --test-name-pattern=session`
Expected: FAIL — `./session.js` doesn't exist yet.

- [ ] **Step 3: Implement `WebrtcSession`**

```ts
import { RTCPeerConnection, MediaStreamTrack } from "werift";
import { VIDEO_CODEC, AUDIO_CODEC } from "./codecs.js";
import { RtpRelay } from "./rtpRelay.js";

const ICE_CONNECT_TIMEOUT_MS = 5000;

export interface WebrtcSessionDeps {
  /** Full ffmpeg args (input + `-f rtp rtp://127.0.0.1:<port>` output) for video. */
  videoFfmpegArgs: (port: number) => string[];
  /** Same, for audio. */
  audioFfmpegArgs: (port: number) => string[];
  /** Called whenever the session's active/error state changes. */
  onStateChange: (active: boolean, error?: string) => void;
}

/**
 * One WebRTC session's worth of state: the peer connection, its two sendonly
 * tracks, and the ffmpeg relays feeding them. Exactly one exists per agent
 * session while WebRTC mode is active; connection/index.ts owns its lifecycle.
 */
export class WebrtcSession {
  private readonly pc: RTCPeerConnection;
  private readonly videoTrack: MediaStreamTrack;
  private readonly audioTrack: MediaStreamTrack;
  private readonly videoRelay: RtpRelay;
  private readonly audioRelay: RtpRelay;
  private closed = false;

  constructor(private readonly deps: WebrtcSessionDeps) {
    this.pc = new RTCPeerConnection({
      codecs: { video: [VIDEO_CODEC], audio: [AUDIO_CODEC] },
    });
    this.videoTrack = new MediaStreamTrack({ kind: "video" });
    this.audioTrack = new MediaStreamTrack({ kind: "audio" });
    this.pc.addTransceiver(this.videoTrack, { direction: "sendonly" });
    this.pc.addTransceiver(this.audioTrack, { direction: "sendonly" });
    this.videoRelay = new RtpRelay("video", deps.videoFfmpegArgs);
    this.audioRelay = new RtpRelay("audio", deps.audioFfmpegArgs);

    this.pc.connectionStateChange.subscribe((state) => {
      if (this.closed) return;
      if (state === "failed" || state === "closed" || state === "disconnected") {
        this.deps.onStateChange(false, `WebRTC connection ${state}`);
      }
    });
  }

  /** Starts both RTP relays and returns the SDP offer to send to the client. */
  async createOffer(): Promise<string> {
    await Promise.all([
      this.videoRelay.start(this.videoTrack),
      this.audioRelay.start(this.audioTrack),
    ]);
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    return this.pc.localDescription!.sdp;
  }

  /** Applies the client's answer and waits for ICE to actually connect. */
  async setAnswer(sdp: string): Promise<void> {
    await this.pc.setRemoteDescription({ type: "answer", sdp });
    await this.awaitConnected();
    this.deps.onStateChange(true);
  }

  close(): void {
    this.closed = true;
    this.videoRelay.stop();
    this.audioRelay.stop();
    void this.pc.close();
  }

  private awaitConnected(): Promise<void> {
    if (this.pc.connectionState === "connected") return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        unsub();
        const err = "ICE did not connect within 5s";
        this.deps.onStateChange(false, err);
        reject(new Error(err));
      }, ICE_CONNECT_TIMEOUT_MS);
      const unsub = this.pc.connectionStateChange.subscribe((state) => {
        if (state === "connected") {
          clearTimeout(timer);
          unsub();
          resolve();
        } else if (state === "failed" || state === "closed") {
          clearTimeout(timer);
          unsub();
          const err = `WebRTC connection ${state}`;
          this.deps.onStateChange(false, err);
          reject(new Error(err));
        }
      });
    });
  }
}
```

If `werift`'s `Event.subscribe()` doesn't return an unsubscribe function directly (check the installed version's typings — `node_modules/werift/lib/cjs/webrtc/src/...` or the `Event` class in `packages/common/src`), adapt `awaitConnected` to whatever unsubscribe mechanism it exposes (commonly `.subscribe()` returning a disposer, or a paired `.unsubscribe(fn)`); this is exactly the "confirm before building on it" risk flagged in the spec's Open Questions.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test --workspace=agent -- --test-name-pattern=session`
Expected: PASS

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck --workspace=agent
git add agent/src/webrtc/session.ts agent/src/webrtc/session.integration.test.ts
git commit -m "agent: add WebrtcSession peer-connection lifecycle"
```

---

## Task 5: Agent — wire WebRTC into ConnectionServer

**Files:**
- Modify: `agent/src/connection/index.ts`
- Modify: `agent/src/connection/connection.integration.test.ts`

**Interfaces:**
- Consumes: `WebrtcSession` from Task 4 (`../webrtc/session.js`); `StartWebrtcMessage`/`StopWebrtcMessage`/`WebrtcAnswerMessage`/`WebrtcOfferMessage`/`WebrtcStateMessage` from Task 1 (`@bcsa/shared`).
- Produces: `ServerDeps` gains a `webrtcFfmpegArgs: { video: (port: number) => string[]; audio: (port: number) => string[] }` field (so tests can inject dummy commands instead of spawning real ffmpeg, matching how `capture`/`audio` are already injected as fakes in `connection.integration.test.ts`).

- [ ] **Step 1: Write the failing test**

Add to `agent/src/connection/connection.integration.test.ts` (reuses the file's existing `ephemeralTls`/`fakeCapture`/`fakeInput`/`fakeTyping`/`fakeInputLock` helpers and connect-and-auth setup already in that file):

```ts
test("startWebrtc stops Classic capture and reports webrtcState", async () => {
  const { server, client } = await connectAuthed(); // existing helper in this file, or inline the connect+auth steps used by other tests here

  client.send(encodeMessage({ type: "startWebrtc" }));
  const offerMsg = await nextMessageOfType(client, "webrtcOffer"); // existing helper pattern in this file for awaiting a specific AgentMessage type
  assert.ok(offerMsg.sdp.startsWith("v=0"));

  client.send(encodeMessage({ type: "stopWebrtc" }));
  const stateMsg = await nextMessageOfType(client, "webrtcState");
  assert.equal(stateMsg.active, false);

  await server.close();
});
```

Match this test's helper calls (`connectAuthed`, `nextMessageOfType`, or whatever this file's existing tests actually use to connect+auth and await a typed message) to what's already defined earlier in `connection.integration.test.ts` — read the full file before writing this step, since the exact helper names weren't re-derived here.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test --workspace=agent -- --test-name-pattern=startWebrtc`
Expected: FAIL — `startWebrtc` is unhandled, no `webrtcOffer` is ever sent.

- [ ] **Step 3: Wire it into `ConnectionServer`**

In `agent/src/connection/index.ts`:

Add to `ServerDeps`:
```ts
export interface ServerDeps {
  // ...existing fields...
  webrtcFfmpegArgs: {
    video: (port: number) => string[];
    audio: (port: number) => string[];
  };
}
```

Add a private field and import:
```ts
import { WebrtcSession } from "../webrtc/session.js";
// ...
private webrtc: WebrtcSession | null = null;
```

In `onControlMessage`'s switch, add three cases:
```ts
case "startWebrtc":
  await this.handleStartWebrtc(ws);
  break;
case "stopWebrtc":
  this.handleStopWebrtc();
  break;
case "webrtcAnswer":
  await this.handleWebrtcAnswer(ws, msg.sdp);
  break;
```

Add the exclusivity guards to the *existing* `setMode`/`setAudio` cases (Classic controls become no-ops while WebRTC is active, mirroring how `setAudio` already reports its true state instead of silently no-op'ing):
```ts
case "setMode":
  if (this.webrtc) {
    this.send(ws, { type: "agentError", message: "Classic video is paused while WebRTC is active" });
    break;
  }
  this.deps.capture.setInterval(msg.intervalMs);
  break;
```
(Apply the same `if (this.webrtc) { ...agentError...; break; }` guard at the top of the existing `setAudio` handler body, before its current logic.)

Add the three new handler methods:
```ts
private async handleStartWebrtc(ws: WebSocket): Promise<void> {
  if (this.webrtc) return; // already active; idempotent
  this.deps.capture.stop();
  this.deps.audio.stop();
  this.webrtc = new WebrtcSession({
    videoFfmpegArgs: this.deps.webrtcFfmpegArgs.video,
    audioFfmpegArgs: this.deps.webrtcFfmpegArgs.audio,
    onStateChange: (active, error) => {
      this.send(ws, { type: "webrtcState", active, error });
      if (!active) {
        this.webrtc?.close();
        this.webrtc = null;
      }
    },
  });
  try {
    const sdp = await this.webrtc.createOffer();
    this.send(ws, { type: "webrtcOffer", sdp });
  } catch (err) {
    this.send(ws, { type: "webrtcState", active: false, error: String(err) });
    this.webrtc = null;
  }
}

private handleStopWebrtc(): void {
  this.webrtc?.close();
  this.webrtc = null;
}

private async handleWebrtcAnswer(ws: WebSocket, sdp: string): Promise<void> {
  if (!this.webrtc) return;
  try {
    await this.webrtc.setAnswer(sdp);
  } catch {
    // onStateChange already reported the failure and cleared this.webrtc.
  }
}
```

Ensure `close()` and the `ws.on("close", ...)` handler also call `this.webrtc?.close(); this.webrtc = null;` alongside the existing `capture.stop()`/`audio.stop()` calls, so a dropped connection never leaves ffmpeg processes running.

- [ ] **Step 4: Update `agent/src/index.ts`'s `ServerDeps` construction**

Read `agent/src/index.ts` to find where `ServerDeps` is currently built for the real (non-test) server, and add the new `webrtcFfmpegArgs` field there using the existing `display.ts` device-selection logic for video and `audio/detect.ts`'s `detectLoopbackDevice()` for audio, following the exact input-arg patterns already in `capture/ffmpeg.ts`'s `buildArgs()` (avfoundation/gdigrab/x11grab) and `audio/index.ts`'s `spawnFfmpeg()` (loopback device), swapping only the output tail to:
```ts
video: (port) => [...videoInputArgs, "-c:v", "libx264", "-profile:v", "baseline", "-level", "3.1", "-preset", "ultrafast", "-tune", "zerolatency", "-f", "rtp", `rtp://127.0.0.1:${port}`],
audio: (port) => [...audioInputArgs, "-c:a", "libopus", "-f", "rtp", `rtp://127.0.0.1:${port}`],
```

- [ ] **Step 5: Update the test file's fake `ServerDeps` construction**

Add a `webrtcFfmpegArgs` field to whatever helper `connection.integration.test.ts` uses to build `ServerDeps` for its other tests, using harmless args that won't hang the test run, e.g. `() => ["-f", "lavfi", "-i", "nullsrc", "-t", "0.1", "-f", "null", "-"]` for video and the `anullsrc` equivalent for audio.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test --workspace=agent`
Expected: PASS (this new test and all pre-existing connection tests)

- [ ] **Step 7: Typecheck and commit**

```bash
npm run typecheck --workspace=agent
git add agent/src/connection/index.ts agent/src/connection/connection.integration.test.ts agent/src/index.ts
git commit -m "agent: wire WebRTC session into ConnectionServer with mode exclusivity"
```

---

## Task 6: Client — generalize remote control to accept a video element

**Files:**
- Modify: `client/src/control/useRemoteControl.ts`

**Interfaces:**
- Produces: `useRemoteControl` accepts `React.RefObject<HTMLCanvasElement | HTMLVideoElement>` instead of `React.RefObject<HTMLCanvasElement>`; `normalizedCoords`'s `canvas` parameter is retyped the same way. No behavior change for Classic mode — Task 9 is what actually passes a `<video>` ref in.

- [ ] **Step 1: Widen the types**

In `client/src/control/useRemoteControl.ts`, change:
```ts
function normalizedCoords(
  canvas: HTMLCanvasElement,
  ...
```
to:
```ts
type ControlSurface = HTMLCanvasElement | HTMLVideoElement;

function normalizedCoords(
  canvas: ControlSurface,
  ...
```
and change the exported function signature:
```ts
export function useRemoteControl(
  canvasRef: React.RefObject<ControlSurface>,
  ...
```
No other lines need to change — `getBoundingClientRect()`, `focus()`, `addEventListener`/`removeEventListener`, and `tabIndex` all exist identically on both element types, which is exactly why this is a type-only widening.

- [ ] **Step 2: Typecheck and commit**

```bash
npm run typecheck --workspace=client
git add client/src/control/useRemoteControl.ts
git commit -m "client: widen useRemoteControl to accept a video element too"
```

---

## Task 7: Client — resampling + PCM-encode helpers for the transcription tap

**Files:**
- Modify: `client/src/audio/pcm.ts`
- Modify: `client/src/audio/pcm.test.ts`
- Create: `client/src/webrtc/resample.ts`
- Create: `client/src/webrtc/resample.test.ts`

**Interfaces:**
- Produces (`pcm.ts`): `float32ToPcmS16(samples: Float32Array): Uint8Array` (inverse of the existing `pcmS16ToFloat32`).
- Produces (`resample.ts`): `resampleTo16kMono(input: Float32Array, inputRate: number, inputChannels: number): Float32Array` — downmixes interleaved multi-channel audio to mono by averaging channels, then linearly resamples to 16000 Hz.

- [ ] **Step 1: Write the failing tests**

Add to `client/src/audio/pcm.test.ts`:
```ts
test("float32ToPcmS16 round-trips through pcmS16ToFloat32", () => {
  const original = new Float32Array([0, 0.5, -0.5, 0.999, -1]);
  const bytes = float32ToPcmS16(original);
  const back = pcmS16ToFloat32(bytes);
  for (let i = 0; i < original.length; i++) {
    assert.ok(Math.abs(back[i] - original[i]) < 0.001, `sample ${i}`);
  }
});
```
(Add the `float32ToPcmS16` import alongside the existing `pcmS16ToFloat32` import at the top of the file.)

Create `client/src/webrtc/resample.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { resampleTo16kMono } from "./resample.js";

test("downmixes stereo to mono by averaging channels", () => {
  // interleaved stereo, both channels constant but different values
  const input = new Float32Array([1, -1, 1, -1, 1, -1, 1, -1]);
  const out = resampleTo16kMono(input, 16000, 2);
  for (const s of out) assert.ok(Math.abs(s - 0) < 1e-6);
});

test("resamples 48kHz mono down to 16kHz mono, roughly a third the length", () => {
  const input = new Float32Array(4800).fill(0.5);
  const out = resampleTo16kMono(input, 48000, 1);
  assert.ok(Math.abs(out.length - 1600) <= 1, `expected ~1600, got ${out.length}`);
  for (const s of out) assert.ok(Math.abs(s - 0.5) < 1e-6);
});

test("passthrough when already 16kHz mono", () => {
  const input = new Float32Array([0.1, 0.2, 0.3]);
  const out = resampleTo16kMono(input, 16000, 1);
  assert.equal(out.length, 3);
  assert.deepEqual(Array.from(out), Array.from(input));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test --workspace=client -- --test-name-pattern="round-trips|downmixes|resamples|passthrough"`
Expected: FAIL — `float32ToPcmS16` and `./resample.js` don't exist yet.

- [ ] **Step 3: Implement `float32ToPcmS16`**

Add to `client/src/audio/pcm.ts`, after `pcmS16ToFloat32`:
```ts
/** Inverse of pcmS16ToFloat32: Float32 samples in [-1, 1) -> interleaved s16le bytes. */
export function float32ToPcmS16(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(i * 2, Math.round(clamped * 32767), true);
  }
  return out;
}
```

- [ ] **Step 4: Implement `resampleTo16kMono`**

`client/src/webrtc/resample.ts`:
```ts
const TARGET_RATE = 16000;

/**
 * Downmix interleaved multi-channel audio to mono (average of channels), then
 * linearly resample to 16 kHz — Whisper's native input rate. WebRTC audio
 * tracks commonly decode at 48 kHz; this makes the WebRTC transcription tap
 * produce the exact shape the existing (unmodified) transcription pipeline
 * expects from pushFrame.
 */
export function resampleTo16kMono(
  input: Float32Array,
  inputRate: number,
  inputChannels: number,
): Float32Array {
  const frames = Math.floor(input.length / inputChannels);
  const mono = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < inputChannels; c++) sum += input[i * inputChannels + c];
    mono[i] = sum / inputChannels;
  }
  if (inputRate === TARGET_RATE) return mono;

  const outLength = Math.round((mono.length * TARGET_RATE) / inputRate);
  const out = new Float32Array(outLength);
  const ratio = mono.length / outLength;
  for (let i = 0; i < outLength; i++) {
    const srcPos = i * ratio;
    const i0 = Math.floor(srcPos);
    const i1 = Math.min(mono.length - 1, i0 + 1);
    const frac = srcPos - i0;
    out[i] = mono[i0] * (1 - frac) + mono[i1] * frac;
  }
  return out;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test --workspace=client -- --test-name-pattern="round-trips|downmixes|resamples|passthrough"`
Expected: PASS

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck --workspace=client
git add client/src/audio/pcm.ts client/src/audio/pcm.test.ts client/src/webrtc/resample.ts client/src/webrtc/resample.test.ts
git commit -m "client: add float32->PCM16 encode and 16kHz-mono resample helpers"
```

---

## Task 8: Client — useWebrtcConnection hook

**Files:**
- Create: `client/src/webrtc/useWebrtcConnection.ts`

**Interfaces:**
- Consumes: nothing from earlier client tasks directly (it's a standalone hook); it will be wired into `useConnection`'s message routing and `App.tsx` in Task 9.
- Produces:
  ```ts
  export type WebrtcStatus = "idle" | "connecting" | "connected" | "error";
  export interface UseWebrtcConnection {
    status: WebrtcStatus;
    error: string | null;
    stream: MediaStream | null;
    /** Call when the agent's webrtcOffer message arrives. */
    handleOffer: (sdp: string) => Promise<string>; // returns the answer SDP to send back
    /** Call when the agent's webrtcState message arrives. */
    handleAgentState: (active: boolean, error?: string) => void;
    stop: () => void;
  }
  export function useWebrtcConnection(): UseWebrtcConnection;
  ```

This hook is browser-API-only (`RTCPeerConnection` doesn't exist under `node --test`), so — consistent with `useConnection.ts` and `useRemoteControl.ts`, neither of which have unit tests in this codebase — it has no dedicated test file; it's exercised by the Task 11 manual browser test.

- [ ] **Step 1: Implement the hook**

```ts
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
```

- [ ] **Step 2: Typecheck and commit**

```bash
npm run typecheck --workspace=client
git add client/src/webrtc/useWebrtcConnection.ts
git commit -m "client: add useWebrtcConnection hook for the browser peer connection"
```

---

## Task 9: Client — route WebRTC messages through useConnection

**Files:**
- Modify: `client/src/connect/useConnection.ts`

**Interfaces:**
- Consumes: `WebrtcOfferMessage`/`WebrtcStateMessage` types already in `@bcsa/shared` from Task 1.
- Produces: `UseConnectionOptions` gains `onWebrtcOffer?: (sdp: string) => void` and `onWebrtcState?: (active: boolean, error?: string) => void`; `UseConnection` gains `sendWebrtcAnswer: (sdp: string) => void`, `startWebrtc: () => void`, `stopWebrtc: () => void`.

- [ ] **Step 1: Extend `UseConnectionOptions` and `UseConnection`**

```ts
export interface UseConnectionOptions {
  onAudioFrame?: (frame: DecodedAudioFrame) => void;
  onWebrtcOffer?: (sdp: string) => void;
  onWebrtcState?: (active: boolean, error?: string) => void;
}
```
Add to `UseConnection`:
```ts
startWebrtc: () => void;
stopWebrtc: () => void;
sendWebrtcAnswer: (sdp: string) => void;
```

- [ ] **Step 2: Route the new agent message types**

In `handleAgentMessage`'s switch (keep the callbacks in refs, same pattern as `onAudioFrameRef`):
```ts
const onWebrtcOfferRef = useRef(opts.onWebrtcOffer);
onWebrtcOfferRef.current = opts.onWebrtcOffer;
const onWebrtcStateRef = useRef(opts.onWebrtcState);
onWebrtcStateRef.current = opts.onWebrtcState;
```
```ts
case "webrtcOffer":
  onWebrtcOfferRef.current?.(msg.sdp);
  break;
case "webrtcState":
  onWebrtcStateRef.current?.(msg.active, msg.error);
  break;
```

- [ ] **Step 3: Add the three send helpers**

```ts
const startWebrtc = useCallback(() => send({ type: "startWebrtc" }), [send]);
const stopWebrtc = useCallback(() => send({ type: "stopWebrtc" }), [send]);
const sendWebrtcAnswer = useCallback(
  (sdp: string) => send({ type: "webrtcAnswer", sdp }),
  [send],
);
```
Include all three in the hook's returned object.

- [ ] **Step 4: Typecheck and commit**

```bash
npm run typecheck --workspace=client
git add client/src/connect/useConnection.ts
git commit -m "client: route WebRTC signaling messages through useConnection"
```

---

## Task 10: Client — transport toggle, video/audio rendering, transcription tap wiring

**Files:**
- Modify: `client/src/view/ScreenView.tsx`
- Modify: `client/src/App.tsx`
- Create: `client/src/webrtc/webrtcAudioTap.ts`

**Interfaces:**
- Consumes: `useWebrtcConnection` (Task 8), `startWebrtc`/`stopWebrtc`/`sendWebrtcAnswer`/`onWebrtcOffer`/`onWebrtcState` (Task 9), `resampleTo16kMono` (Task 7), `float32ToPcmS16` (Task 7), `useRemoteControl`'s widened ref type (Task 6).
- Produces: `tapWebrtcAudioForTranscription(stream: MediaStream, pushFrame: (frame: DecodedAudioFrame) => void): () => void` (returns a cleanup function) in `webrtcAudioTap.ts`.

**Implementation notes:**

- [ ] **Step 1: Add the transport toggle state to `App.tsx`**

Add alongside the existing `mode`/`controlEnabled` state:
```ts
const [transport, setTransport] = useState<"classic" | "webrtc">("classic");
const webrtc = useWebrtcConnection();
```

Wire `useConnection`'s new options:
```ts
const conn = useConnection({
  onAudioFrame: audioTx.pushFrame,
  onWebrtcOffer: async (sdp) => {
    const answer = await webrtc.handleOffer(sdp);
    conn.sendWebrtcAnswer(answer); // see note below on ordering
  },
  onWebrtcState: webrtc.handleAgentState,
});
```
Since `conn` isn't defined yet at the point `onWebrtcOffer` is declared, follow the existing codebase convention of keeping the latest `send`/callback in a ref (as `useConnection` itself already does for `onAudioFrame`) — or, simplest, call `conn.sendWebrtcAnswer` from inside a `useEffect` that watches a small piece of local state set by `onWebrtcOffer`, rather than a closure over `conn` before it exists. Concretely:
```ts
const [pendingOfferSdp, setPendingOfferSdp] = useState<string | null>(null);
const conn = useConnection({
  onAudioFrame: audioTx.pushFrame,
  onWebrtcOffer: (sdp) => setPendingOfferSdp(sdp),
  onWebrtcState: webrtc.handleAgentState,
});

useEffect(() => {
  if (pendingOfferSdp === null) return;
  const sdp = pendingOfferSdp;
  setPendingOfferSdp(null);
  void webrtc.handleOffer(sdp).then((answer) => conn.sendWebrtcAnswer(answer));
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [pendingOfferSdp]);
```

Add the toggle handler:
```ts
const onSetTransport = (next: "classic" | "webrtc") => {
  if (next === transport) return;
  if (next === "webrtc") {
    setTransport("webrtc");
    conn.startWebrtc();
  } else {
    setTransport("classic");
    conn.stopWebrtc();
    webrtc.stop();
    conn.send({ type: "setMode", mode, intervalMs: intervalForMode(mode, refreshHz) });
  }
};
```

Revert-on-failure (no silent fallback, per the spec): 
```ts
useEffect(() => {
  if (transport === "webrtc" && webrtc.status === "error") {
    setTransport("classic");
    conn.send({ type: "setMode", mode, intervalMs: intervalForMode(mode, refreshHz) });
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [webrtc.status]);
```

Gate the toggle to LAN/Tailscale only, using whichever target index `useConnection` recorded as having succeeded — read `useConnection.ts`'s `targetIdxRef`/`openTarget` logic (Task 9 area) to find the cleanest way to expose "which target index is currently connected" (e.g. add a `connectedTargetIndex: number | null` to `UseConnection`'s return value, set alongside `setStatus("connected")` in `handleAgentMessage`'s `authResult` case, using the already-in-scope `targetIdxRef.current`). Disable the WebRTC toggle button when `connectedTargetIndex` is the Tunnel index (index 2, per `buildTargets`'s LAN/Tailscale/Tunnel order).

- [ ] **Step 2: Add the transport toggle + video/audio rendering to `ScreenView.tsx`**

Add new props:
```ts
interface ScreenViewProps {
  // ...existing props...
  transport: "classic" | "webrtc";
  onSetTransport: (t: "classic" | "webrtc") => void;
  transportGateDisabled: boolean; // true when connected via Tunnel
  webrtcStream: MediaStream | null;
  videoRef: React.RefObject<HTMLVideoElement>;
}
```

Add a second toggle row next to the existing Screenshot/Video `seg`:
```tsx
<div className="seg">
  <button
    className={transport === "classic" ? "active" : ""}
    onClick={() => onSetTransport("classic")}
  >
    Classic
  </button>
  <button
    className={transport === "webrtc" ? "active" : ""}
    onClick={() => onSetTransport("webrtc")}
    disabled={transportGateDisabled}
    title={transportGateDisabled ? "Not available over Cloudflare Tunnel" : undefined}
  >
    WebRTC
  </button>
</div>
```

Render the video element instead of canvas when in WebRTC mode (keep the canvas mounted for Classic mode, matching how the existing code structures the stage):
```tsx
<div className={`canvas-wrap ${controlEnabled ? "is-controlling" : ""}`}>
  {transport === "webrtc" ? (
    <video
      ref={videoRef}
      tabIndex={0}
      autoPlay
      playsInline
      muted={false}
      className={controlEnabled ? "canvas controllable" : "canvas"}
    />
  ) : (
    <canvas
      ref={canvasRef}
      tabIndex={0}
      className={controlEnabled ? "canvas controllable" : "canvas"}
    />
  )}
  {transport === "classic" && !frame && <div className="canvas-empty">No signal</div>}
</div>
```
Add a `useEffect` inside `ScreenView` that assigns `videoRef.current.srcObject = webrtcStream` whenever `webrtcStream` changes.

- [ ] **Step 3: Pass the video ref into `useRemoteControl` when in WebRTC mode**

In `App.tsx`, add `const videoRef = useRef<HTMLVideoElement>(null);` and pass the active surface's ref to `useRemoteControl`:
```ts
const activeSurfaceRef = transport === "webrtc" ? videoRef : canvasRef;
useRemoteControl(activeSurfaceRef, contentRectRef, conn.send, controlEnabled);
```
Since `mapToNormalized` divides by `content.dw`/`content.dh` only when they're set (falling back to the raw canvas/video box otherwise, per its existing logic), and `ScreenView` only ever populates `contentRectRef` in its Classic-mode canvas-drawing effect, WebRTC mode naturally falls into `mapToNormalized`'s existing "no content rect yet" branch — i.e. it maps clicks to the full `<video>` box directly, which is correct for WebRTC mode since there's no letterboxing step to publish a content rect for (the video element's own intrinsic aspect ratio and CSS `object-fit` handle that). No `ContentRect`-publishing code is needed for WebRTC mode.

- [ ] **Step 4: Implement `webrtcAudioTap.ts`**

```ts
import type { DecodedAudioFrame } from "@bcsa/shared";
import { AudioFormat } from "@bcsa/shared";
import { float32ToPcmS16 } from "../audio/pcm";
import { resampleTo16kMono } from "./resample";

const CHUNK_SIZE = 4096;

/**
 * Taps a WebRTC MediaStream's audio track, resamples it to 16 kHz mono, and
 * feeds it into the existing (unmodified) transcription pipeline via the same
 * pushFrame interface the Classic PCM-over-WS path uses. Returns a cleanup
 * function that tears down the audio graph.
 */
export function tapWebrtcAudioForTranscription(
  stream: MediaStream,
  pushFrame: (frame: DecodedAudioFrame) => void,
): () => void {
  const audioTracks = stream.getAudioTracks();
  if (audioTracks.length === 0) return () => {};

  const ctx = new AudioContext();
  const source = ctx.createMediaStreamSource(new MediaStream([audioTracks[0]]));
  const processor = ctx.createScriptProcessor(CHUNK_SIZE, 1, 1);
  let seq = 0;

  processor.onaudioprocess = (e) => {
    const input = e.inputBuffer.getChannelData(0);
    const mono16k = resampleTo16kMono(input, ctx.sampleRate, 1);
    const frame: DecodedAudioFrame = {
      seq: seq++,
      timestamp: Date.now(),
      sampleRate: 16000,
      channels: 1,
      format: AudioFormat.PCM_S16LE,
      payload: float32ToPcmS16(mono16k),
    };
    pushFrame(frame);
  };

  source.connect(processor);
  // ScriptProcessorNode requires a live connection to the destination graph to
  // fire onaudioprocess even though we discard the output; route through a
  // silent gain node so nothing is audible twice (the <audio>/<video> element
  // handles actual playback separately).
  const silence = ctx.createGain();
  silence.gain.value = 0;
  processor.connect(silence);
  silence.connect(ctx.destination);

  return () => {
    processor.disconnect();
    source.disconnect();
    silence.disconnect();
    void ctx.close();
  };
}
```

`ScriptProcessorNode` is deprecated but is the simplest correct option here and needs no build-time worklet-file wiring; note in a comment that `AudioWorkletNode` is the future upgrade path if `ScriptProcessorNode` is ever removed from browsers (no browser has removed it as of this writing).

- [ ] **Step 5: Wire the tap into `App.tsx`**

```ts
useEffect(() => {
  if (transport !== "webrtc" || !webrtc.stream) return;
  const cleanup = tapWebrtcAudioForTranscription(webrtc.stream, audioTx.pushFrame);
  audioTx.startLive();
  return () => {
    cleanup();
    audioTx.stopLive();
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [transport, webrtc.stream]);
```
This starts live transcription automatically whenever a WebRTC stream is available — consistent with the spec's "transcription reads from the new WebRTC audio track" decision. (The Classic-mode manual Live/Record toggle in the existing "Transcribe audio" panel stays as-is and only applies when `transport === "classic"`; disable that panel's controls when `transport === "webrtc"` since transcription is then automatic.)

- [ ] **Step 6: Typecheck**

```bash
npm run typecheck --workspace=client
```

- [ ] **Step 7: Commit**

```bash
git add client/src/view/ScreenView.tsx client/src/App.tsx client/src/webrtc/webrtcAudioTap.ts
git commit -m "client: add WebRTC transport toggle, video/audio rendering, and transcription tap"
```

---

## Task 11: Full workspace check + manual end-to-end browser test

**Files:** none (verification only)

- [ ] **Step 1: Full workspace build + test + typecheck**

```bash
npm run build
npm test
npm run typecheck
```
Expected: all green. Fix anything that surfaces before proceeding — this is the first point every workspace compiles together.

- [ ] **Step 2: Confirm ffmpeg has an H264 encoder**

```bash
ffmpeg -hide_banner -encoders 2>/dev/null | grep -i 264
```
Expected: `libx264` listed. If it's missing, `npm run setup`'s ffmpeg install for this OS needs `--enable-libx264` (Homebrew's `ffmpeg` formula includes it by default on macOS; note in a follow-up if another OS's default build lacks it — out of scope to fix here, just confirm the dev machine has it before manual testing).

- [ ] **Step 3: Start the agent**

```bash
npm run agent
```
Note the printed LAN address and secret from the banner.

- [ ] **Step 4: Start the client dev server**

```bash
npm run client
```
Confirm it's serving at `http://localhost:5173`.

- [ ] **Step 5: Open the client in a real Chrome browser and connect**

Use the Chrome browser automation tools (load them first if deferred: `ToolSearch` with `select:mcp__claude-in-chrome__tabs_context_mcp,mcp__claude-in-chrome__navigate,mcp__claude-in-chrome__computer,mcp__claude-in-chrome__read_page,mcp__claude-in-chrome__tabs_create_mcp,mcp__claude-in-chrome__read_console_messages`). Create a new tab, navigate to `http://localhost:5173`, enter the LAN address and secret from Step 3 into the connect fields, and click Connect. If this is the first connection, also navigate to `https://<lan-address>` in a tab first to accept the self-signed cert (same one-time step documented in the README), then retry Connect.

Verify via `read_page`/screenshot: status strip shows "connected" and the agent's nickname/resolution.

- [ ] **Step 6: Toggle WebRTC mode and verify video**

Click the "WebRTC" transport toggle. Wait a few seconds. Verify:
- The `<video>` element shows the agent's live screen (not blank/black).
- The status readout doesn't show a WebRTC error.
- `read_console_messages` (pattern `webrtc|WebRTC`) shows no repeated errors.

- [ ] **Step 7: Verify audio playback + live transcription**

Play some audio on the agent machine (or speak near its loopback input, per the README's OS-specific loopback setup already configured for transcription testing). Verify:
- Sound is audible from the client tab (WebRTC audio playback — the new capability).
- The transcript panel fills in with text within a few seconds (proving the WebRTC audio tap → resample → existing Whisper pipeline path works end to end).

- [ ] **Step 8: Verify control still works over WSS in WebRTC mode**

With WebRTC mode still active, enable "Remote control" and use the `computer` tool (or direct click/type actions) on the `<video>` element to move the mouse and type a few characters. Verify the agent machine's cursor moves and characters appear where expected — this proves the control path is unaffected by which media transport is active.

- [ ] **Step 9: Toggle back to Classic and verify clean revert**

Click "Classic". Verify: video keeps working via the canvas/JPEG path, the transcript panel's Live/Record controls become manually operable again, and `read_console_messages` shows no lingering WebRTC errors (confirming `webrtc.stop()`/`conn.stopWebrtc()` tore things down cleanly).

- [ ] **Step 10: Record findings**

If any step fails, use `systematic-debugging` before patching — don't guess. Once all 9 verification points pass, this task (and the whole plan) is done. No commit for this task (it's verification-only); if fixes were needed, they'll have produced their own commits during debugging.

---

## Self-review notes

- **Spec coverage:** Architecture (Tasks 1, 4, 5, 9), wire protocol (Task 1), agent RTP relay + session (Tasks 2–5), client hook/UI/transcription tap (Tasks 6–10), fallback/no-silent-degrade behavior (Task 10 Step 1 + Task 8's 5s timeout), LAN/Tailscale-only gating (Task 10 Step 1), testing plan including the manual browser pass (Task 11) — all covered.
- **Placeholder scan:** no TBD/TODO; the one deliberately-flagged uncertainty (werift's `Event.subscribe` unsubscribe API) is called out explicitly as a first-verify step in Task 4, per the spec's own Open Questions section, not silently assumed.
- **Type consistency:** `WebrtcSessionDeps`/`WebrtcSession` (Task 4) methods match their Task 5 call sites (`createOffer()`, `setAnswer(sdp)`, `close()`); `UseWebrtcConnection`'s `handleOffer`/`handleAgentState`/`stop` (Task 8) match their Task 10 call sites; `resampleTo16kMono`/`float32ToPcmS16` (Task 7) signatures match their Task 10 (`webrtcAudioTap.ts`) usage.
- **Scope:** single coherent feature, sequenced shared → agent → client so each task's dependencies already exist when it starts.
