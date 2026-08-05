# Clipboard sync between client and agent

## Problem

Pressing Ctrl+C/X/V while remote-controlling only affects the **agent's**
clipboard — the keystroke is forwarded and executed there, so a copy on the
agent never reaches the client's own clipboard, and vice versa for paste. The
two clipboards are entirely separate systems; nothing links them.

## Design

### Protocol (`shared/src/messages.ts`)

- `GetClipboardMessage` (client→agent) — `{ type: "getClipboard" }`.
- `SetClipboardMessage` (client→agent) — `{ type: "setClipboard", text: string }`.
- `ClipboardContentMessage` (agent→client) — `{ type: "clipboardContent", text: string }`, reply to `getClipboard`.

Text-only, matching nut-js's own clipboard API (no images/rich content).
Failures reuse the existing `AgentErrorMessage` path — no new error message
type needed.

### Agent (`agent/src/clipboard/index.ts`, wired into `connection/index.ts`)

`ClipboardBackend` interface + `createNutClipboardBackend()`, using nut-js's
already-a-dependency `clipboard.getContent()`/`setContent()` — no new
dependency. Lazy-imported, matching `input/nutBackend.ts` and
`autotyper/nutTyping.ts`, so unit tests never load the native module.

`onControlMessage` handles both message types; the surrounding try/catch
already reports thrown errors as `agentError`, so no extra error handling
needed in the handlers themselves.

### Client (`useConnection.ts`, `App.tsx`, `useRemoteControl.ts`)

**Manual**: a "Clipboard" card in the sidebar with "Get remote clipboard" /
"Send to remote" buttons, independent of the Remote control toggle — you can
sync clipboard without taking control of the mouse/keyboard.
- Get: sends `getClipboard`; on reply, `navigator.clipboard.writeText()`.
- Send: `navigator.clipboard.readText()`, then sends `setClipboard`.

**Automatic** (added mid-implementation, at the user's request): while Remote
control is on, Ctrl/Cmd+C, +X, and +V trigger the same sync automatically:
- **Copy/cut**: forward the keystroke, then after `CLIPBOARD_COPY_FETCH_DELAY_MS`
  (200ms) call `getClipboard()` — the OS needs a moment to actually populate
  its clipboard after the keypress lands, independent of network latency.
- **Paste**: call `setClipboard()` first, then forward the keystroke after
  `CLIPBOARD_PASTE_DELAY_MS` (150ms) — so the agent has the new clipboard
  content before it pastes. The delay is necessary even after the send
  completes: the agent dispatches each incoming message via a fire-and-forget
  call (`void this.onControlMessage(...)`), not one awaited before the next,
  so two native calls (clipboard set vs. key press) racing with no gap could
  finish in either order.
- The corresponding **keyup** for Ctrl/Cmd+V is delayed by the same amount,
  otherwise it could reach the agent before the (deliberately delayed) keydown
  — a key-up with no preceding key-down. Since releasing a key is always at or
  after pressing it, adding the same delay to both preserves their order.
- Manual buttons remain as a fallback (e.g. after a right-click "Copy" that
  doesn't go through a keyboard shortcut).

## Testing

- `agent/src/connection/connection.integration.test.ts`: a real WebSocket
  round trip — `getClipboard` returns the agent's actual clipboard text
  (verified against a fake backend, not inferred), and `setClipboard`
  actually changes it.
- Manual click-through in a real browser confirmed no console/agent errors,
  though a decisive same-machine test isn't possible: the agent and the
  testing browser share one OS clipboard, so any bug could hide behind "the
  value was already right." The automated test above is the real proof.
- The keyboard auto-sync path (Ctrl/Cmd+C/X/V interception, the two delay
  constants) was implemented but not separately covered by an automated test
  — no existing test harness drives real `KeyboardEvent`s through
  `useRemoteControl`. Flagging this gap explicitly rather than claiming it's
  tested.
