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
  intervalMs: z.number().int().min(20).max(60_000),
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

/**
 * Ask the agent to lock (or unlock) the physical keyboard + mouse at the agent
 * machine, so only the client controls it. The agent auto-releases the lock
 * after a period of no client activity, and unlocks if the client disconnects.
 */
export const SetInputLockMessage = z.object({
  type: z.literal("setInputLock"),
  locked: z.boolean(),
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
});

export const AgentErrorMessage = z.object({
  type: z.literal("agentError"),
  message: z.string(),
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

// ---- unions ----

export const ClientMessage = z.discriminatedUnion("type", [
  AuthMessage,
  SetModeMessage,
  MouseMessage,
  KeyMessage,
  AutotypeMessage,
  SetInputLockMessage,
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

export const AgentMessage = z.discriminatedUnion("type", [
  AuthResultMessage,
  AgentInfoMessage,
  AutotypeProgressMessage,
  AutotypeDoneMessage,
  AgentErrorMessage,
  InputLockStateMessage,
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
