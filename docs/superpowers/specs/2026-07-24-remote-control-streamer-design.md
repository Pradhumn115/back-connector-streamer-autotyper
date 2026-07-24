# Back Connector: Streamer + Autotyper — Design Spec

**Date:** 2026-07-24
**Status:** Approved for implementation

## Purpose

A personal remote-control tool for machines you own. A **client** (web app) connects
to an **agent** (running on the controlled machine) to:

- View the agent's screen — either as a live-ish video stream or as periodic screenshots
  (user-selectable).
- Control the agent's mouse and keyboard from the browser.
- Trigger a **human-like autotyper** that types a block of text on the agent with
  realistic, variable cadence (randomized delays + occasional backspace/correct).

Use case: personal remote desktop (control your own second machine) and
operator-aware automation/testing. Not a covert/stealth tool — no evasion or
hiding features.

## Non-Goals (v1)

- Multi-user / concurrent controllers (one controller at a time, enforced).
- Per-action audit logging, remote session revocation, brute-force rate limiting.
- Letting a third party who has NOT installed Tailscale connect from off-LAN.
- True WebRTC video. Deferred fallback if WebSocket frame streaming feels laggy
  (see "Deferred / Fallbacks").

## Architecture

```
┌─────────────┐   LAN IP (fast path) or Tailscale IP (remote)  ┌─────────────┐
│   Client     │◄────────────────────────────────────────────►│    Agent     │
│  (web app)   │              direct WSS, no relay              │ (controlled  │
│              │                                                │  machine)    │
└─────────────┘                                                └─────────────┘
```

- **No relay / no VPS.** The agent runs a local WebSocket (WSS) server. The client
  connects directly.
- **LAN:** client connects to the agent's LAN IP (e.g. `192.168.1.x`). No extra
  software needed on either machine.
- **Remote (different networks):** both machines join the user's **Tailscale**
  (WireGuard) network; client connects to the agent's Tailscale IP (`100.x.y.z`).
  Tailscale handles NAT traversal; nothing self-hosted.
- **Dual-path connect:** client tries the LAN IP first (short timeout ~1.5s), then
  falls back to the Tailscale IP.

### Language / Stack

- **TypeScript everywhere** (agent, client, shared types).
- **Transport:** WebSocket over TLS (`wss://`). Video/screenshot "mode" is the same
  JPEG-frame pipeline at different capture intervals — NOT WebRTC in v1.
- **Screen capture (agent):** `screenshot-desktop` (cross-platform JPEG/PNG capture).
  `ffmpeg` child-process capture is a documented optimization path if per-frame
  `screenshot-desktop` throughput is insufficient for video mode.
- **Input injection (agent):** `@nut-tree/nut-js` (cross-platform mouse + keyboard).
- **Client:** React + Vite, renders frames to a `<canvas>`.
- **Validation:** `zod` schemas shared across both ends.

## Packages (npm/pnpm workspaces monorepo)

```
back-connector-streamer-autotyper/
├── shared/           # TS types + zod schemas for all wire messages
├── agent/            # runs on the controlled machine (Node.js)
│   ├── src/capture/      # screen grab loop, JPEG encode
│   ├── src/input/        # nut-js wrapper, coord translation
│   ├── src/autotyper/    # human-like typing engine
│   ├── src/connection/   # WSS server, auth handshake, one-controller lock
│   ├── src/config.ts     # shared secret, port, nickname
│   └── src/index.ts
├── client/           # web app (React + Vite)
│   ├── src/view/         # canvas renderer, mode toggle
│   ├── src/control/      # capture local mouse/keyboard, normalize, send
│   ├── src/autotype-panel/  # text box + trigger UI
│   ├── src/connect/      # dual-path connect + pairing UI
│   └── src/main.tsx
└── package.json      # workspaces root
```

## Wire Protocol (`shared/`)

All messages are validated with zod. Two channels over one WebSocket:

- **Binary messages** = frames: a small header (seq: u32, timestamp: f64, format) +
  JPEG bytes.
- **JSON messages** = control/handshake, discriminated union on `type`:
  - `auth` `{ secret }` (client → agent)
  - `authResult` `{ ok, reason? }` (agent → client)
  - `setMode` `{ mode: 'screenshot' | 'video', intervalMs }` (client → agent)
  - `mouse` `{ action: 'move'|'down'|'up'|'click'|'scroll', x, y, button?, dx?, dy? }`
    coordinates normalized 0–1 (client → agent)
  - `key` `{ action: 'down'|'up'|'press', key, modifiers? }` (client → agent)
  - `autotype` `{ text, profile: { baseDelayMs, jitterMs, typoRate } }` (client → agent)
  - `autotypeProgress` `{ done, total }` (agent → client)
  - `autotypeDone` `{}` (agent → client)
  - `agentError` `{ message }` (agent → client)
  - `agentInfo` `{ screenWidth, screenHeight, nickname }` (agent → client, after auth)

## Data Flow

**Connect / pair:**
1. Agent starts, generates a self-signed TLS cert on first run (persisted), prints its
   LAN IP, Tailscale IP (if present), port, and cert fingerprint.
2. Client is given `<ip>:<port>` (+ optional second IP) and the shared secret; these
   can be combined into one connect string. Cert fingerprint is pinned by the client.
3. Client tries LAN IP first (~1.5s timeout), then Tailscale IP.
4. On open, client sends `auth`. Agent validates the secret, and rejects if a
   controller is already connected. On success agent sends `agentInfo`.

**Streaming (agent → client):** capture loop JPEG-encodes each frame → binary WS
message with incrementing seq. `setMode` adjusts the capture interval (screenshot ≈
2000ms, video ≈ 50ms). Client always renders the latest frame and drops backlog
(no queue buildup → stays near-live).

**Control (client → agent):** mouse/key JSON messages sent as they occur. Agent
translates normalized 0–1 coords to real screen resolution, then calls nut-js.
Control messages are a distinct type so mouse-move bursts don't queue behind a large
frame.

**Autotyper (client → agent):** one `autotype` command; the agent runs the typing
loop LOCALLY (no per-keystroke network round-trip, so cadence isn't corrupted by
jitter). Human-like behavior: per-char delay = `baseDelayMs ± jitterMs`, with
`typoRate` chance to type a wrong adjacent char then backspace and correct. Agent
emits `autotypeProgress` / `autotypeDone`.

**Errors:** WS close/error → client reconnect-with-backoff (LAN then Tailscale).
Agent capture/input errors are caught, logged, and reported as `agentError` rather
than crashing the process.

## Security (Basic tier)

- WSS/TLS on both paths. Self-signed cert generated on first run; client pins the
  specific cert fingerprint (not "accept any self-signed") to prevent LAN MITM.
- Shared secret in agent config; entered once in client, cached in localStorage.
- One controller at a time. Agent binds only LAN/Tailscale interfaces, never a public
  `0.0.0.0` internet-facing socket by default.
- Out of scope (conscious): audit log, remote revoke, failed-attempt rate limiting.

## Testing

- `shared/`: zod schema parse/reject unit tests.
- `agent/autotyper`: unit tests on timing + typo-injection logic (nut-js mocked).
- `agent/input`: coordinate-translation math tests (nut-js mocked).
- `agent/connection` + `client/connect`: integration test — real agent WS server +
  client connect/auth/exchange a mock frame + mock input event.
- Manual pass per OS for real capture/injection/autotype (needs OS permissions:
  macOS Screen Recording + Accessibility; not practical to fully automate).

## Deferred / Fallbacks

- **WebRTC video path** (via `werift`, pure-TS) if JPEG-over-WS latency/bandwidth is
  unacceptable in practice. Rest of the architecture (auth, input, autotyper, connect)
  is unchanged, so it's a swap of the video transport only.
- **ffmpeg-based capture** if `screenshot-desktop` per-frame throughput limits video fps.
- Direct-only LAN mode already works without Tailscale; Tailscale is opt-in per remote
  session.
