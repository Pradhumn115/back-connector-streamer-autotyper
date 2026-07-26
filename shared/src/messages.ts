import { z } from "zod";

/**
 * All JSON control messages exchanged over the WebSocket, as a discriminated
 * union on `type`. Binary frames are handled separately (see frame.ts).
 *
 * Coordinates on mouse messages are normalized 0..1 relative to the agent's
 * screen so the client never needs to know the agent's real resolution.
 */

export const StreamMode = z.enum(["screenshot", "video"]);
export type StreamMode = z.infer<typeof StreamMode>;

// ---- client -> agent ----

export const AuthMessage = z.object({
  type: z.literal("auth"),
  secret: z.string().min(1),
});

export const SetModeMessage = z.object({
  type: z.literal("setMode"),
  mode: StreamMode,
  // Min 4ms allows up to ~250fps requests (agent caps the real rate to 120 and
  // to what the display/capture can sustain). It must stay below the highest-fps
  // interval the client sends — 120fps = ~8ms, 60fps = ~17ms — or the agent
  // rejects setMode as malformed and streaming stalls at the default interval.
  intervalMs: z.number().int().min(4).max(60_000),
});

export const MouseButton = z.enum(["left", "right", "middle"]);
export type MouseButton = z.infer<typeof MouseButton>;

export const MouseMessage = z.object({
  type: z.literal("mouse"),
  action: z.enum(["move", "down", "up", "click", "scroll"]),
  // normalized 0..1; required for move/down/up/click, optional for scroll
  x: z.number().min(0).max(1).optional(),
  y: z.number().min(0).max(1).optional(),
  button: MouseButton.optional(),
  dx: z.number().optional(),
  dy: z.number().optional(),
});
export type MouseMessage = z.infer<typeof MouseMessage>;

export const KeyMessage = z.object({
  type: z.literal("key"),
  action: z.enum(["down", "up", "press"]),
  // a single key name, e.g. "a", "Enter", "ArrowLeft", "F5"
  key: z.string().min(1),
  modifiers: z
    .array(z.enum(["ctrl", "alt", "shift", "meta"]))
    .optional()
    .default([]),
});
export type KeyMessage = z.infer<typeof KeyMessage>;

export const AutotypeProfile = z.object({
  // average delay between keystrokes, ms
  baseDelayMs: z.number().int().min(0).max(2000).default(90),
  // +/- random jitter applied to each delay, ms
  jitterMs: z.number().int().min(0).max(2000).default(60),
  // probability [0..1] of a mistyped char that gets backspaced & corrected
  typoRate: z.number().min(0).max(1).default(0.03),
});
export type AutotypeProfile = z.infer<typeof AutotypeProfile>;

export const AutotypeMessage = z.object({
  type: z.literal("autotype"),
  text: z.string(),
  profile: AutotypeProfile.default({
    baseDelayMs: 90,
    jitterMs: 60,
    typoRate: 0.03,
  }),
});

/** Cancel an in-progress autotype run. No-op if nothing is typing. */
export const CancelAutotypeMessage = z.object({
  type: z.literal("cancelAutotype"),
});

/** Ask the agent to run its self-diagnostics and report back. */
export const RunDiagnosticsMessage = z.object({
  type: z.literal("runDiagnostics"),
});

/**
 * Ask the agent to lock (or unlock) the physical keyboard + mouse at the agent
 * machine, so only the client controls it. The agent auto-releases the lock
 * after a period of no client activity, and unlocks if the client disconnects.
 */
export const SetInputLockMessage = z.object({
  type: z.literal("setInputLock"),
  locked: z.boolean(),
});

/**
 * Ask the agent to start (or stop) capturing its system output audio and
 * streaming it as binary audio frames. Used by the client only to transcribe —
 * there is no client-side playback. No-op if the agent has no loopback device.
 */
export const SetAudioMessage = z.object({
  type: z.literal("setAudio"),
  enabled: z.boolean(),
});

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

// ---- agent -> client ----

export const AuthResultMessage = z.object({
  type: z.literal("authResult"),
  ok: z.boolean(),
  reason: z.string().optional(),
});

export const AgentInfoMessage = z.object({
  type: z.literal("agentInfo"),
  screenWidth: z.number().int().positive(),
  screenHeight: z.number().int().positive(),
  nickname: z.string(),
  /** Detected display refresh rate (Hz); the client uses it to target fps. */
  refreshHz: z.number().positive().optional(),
});

export const AutotypeProgressMessage = z.object({
  type: z.literal("autotypeProgress"),
  done: z.number().int().min(0),
  total: z.number().int().min(0),
});

export const AutotypeDoneMessage = z.object({
  type: z.literal("autotypeDone"),
  /** True if the run was cancelled before finishing. */
  cancelled: z.boolean().optional().default(false),
});

export const AgentErrorMessage = z.object({
  type: z.literal("agentError"),
  message: z.string(),
});

/** One agent-side diagnostic result. */
export const DiagnosticStatus = z.enum(["ok", "warn", "fail"]);
export type DiagnosticStatus = z.infer<typeof DiagnosticStatus>;

export const DiagnosticCheck = z.object({
  id: z.string(),
  label: z.string(),
  status: DiagnosticStatus,
  /** What was found. */
  detail: z.string(),
  /** How to fix it, if not ok. Instructions only — never executed remotely. */
  fix: z.string().optional(),
});
export type DiagnosticCheck = z.infer<typeof DiagnosticCheck>;

/** Agent's self-diagnostics report, sent in reply to runDiagnostics. */
export const DiagnosticsMessage = z.object({
  type: z.literal("diagnostics"),
  checks: z.array(DiagnosticCheck),
});

/**
 * Reports the agent's local-input lock state. `supported` is false on agent OSes
 * where physical-input blocking isn't implemented, so the client can disable the
 * control and never show a false "locked" state.
 */
export const InputLockStateMessage = z.object({
  type: z.literal("inputLockState"),
  locked: z.boolean(),
  supported: z.boolean(),
});

/**
 * Reports the agent's system-audio capture state. `supported` is false when the
 * agent has no loopback device (e.g. BlackHole/VB-Cable not installed), so the
 * client can disable the transcribe toggle and never wait on audio that will
 * never arrive.
 */
export const AudioStateMessage = z.object({
  type: z.literal("audioState"),
  enabled: z.boolean(),
  supported: z.boolean(),
});

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

// ---- unions ----

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
export type ClientMessage = z.infer<typeof ClientMessage>;

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
export type AgentMessage = z.infer<typeof AgentMessage>;

/** Any message that can appear on the wire (either direction), for parsing. */
export const AnyMessage = z.union([ClientMessage, AgentMessage]);
export type AnyMessage = z.infer<typeof AnyMessage>;

/** Parse a JSON string into a validated ClientMessage. Throws on invalid. */
export function parseClientMessage(raw: string): ClientMessage {
  return ClientMessage.parse(JSON.parse(raw));
}

/** Parse a JSON string into a validated AgentMessage. Throws on invalid. */
export function parseAgentMessage(raw: string): AgentMessage {
  return AgentMessage.parse(JSON.parse(raw));
}

/** Serialize any message to a JSON string for sending. */
export function encodeMessage(msg: ClientMessage | AgentMessage): string {
  return JSON.stringify(msg);
}
