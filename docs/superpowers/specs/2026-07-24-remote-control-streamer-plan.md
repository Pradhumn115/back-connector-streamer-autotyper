# Implementation Plan — Back Connector Streamer + Autotyper

Reference: `2026-07-24-remote-control-streamer-design.md`

## Phase 0 — Monorepo scaffold
- Root `package.json` with npm workspaces: `shared`, `agent`, `client`.
- Root TS config, `.gitignore`, README.
- Each package: `package.json`, `tsconfig.json`.

## Phase 1 — `shared/` (foundational, everything depends on it)
- `src/messages.ts`: zod schemas + inferred TS types for every wire message
  (auth, authResult, setMode, mouse, key, autotype, autotypeProgress, autotypeDone,
  agentError, agentInfo) as a discriminated union `ControlMessage`.
- `src/frame.ts`: binary frame encode/decode (header: seq u32, ts f64, format u8 + JPEG payload).
- `src/index.ts`: barrel export.
- Tests: `messages.test.ts` (parse/reject), `frame.test.ts` (roundtrip).

## Phase 2 — `agent/` (depends on shared)
- `src/config.ts`: load/create JSON config (secret, port, nickname, cert paths); generate
  shared secret if absent.
- `src/tls.ts`: generate + persist self-signed cert on first run; expose fingerprint.
- `src/capture/index.ts`: screen capture loop using `screenshot-desktop`, JPEG frames,
  adjustable interval, latest-frame emit via callback.
- `src/input/index.ts`: nut-js wrapper; `applyMouse`, `applyKey`; normalized→pixel
  coordinate translation using detected screen size.
- `src/autotyper/index.ts`: `runAutotype(text, profile, hooks)` — human-like loop with
  jittered delays + typo/backspace, progress callbacks. nut-js injected for testability.
- `src/connection/index.ts`: WSS server, auth handshake, single-controller lock, routes
  incoming control messages to input/autotyper, pushes frames + agentInfo out.
- `src/index.ts`: wire it all together, CLI startup banner (IPs, port, fingerprint).
- `src/net.ts`: enumerate LAN + Tailscale (100.64.0.0/10) IPs for the banner.
- Tests: `autotyper.test.ts`, `input.test.ts` (coord math), `connection.integration.test.ts`.

## Phase 3 — `client/` (depends on shared)
- Vite + React + TS.
- `src/connect/`: dual-path connect (LAN then Tailscale), auth, localStorage secret,
  cert-pin note. Connection state machine + WS wrapper.
- `src/view/`: `<canvas>` renderer (draws latest decoded JPEG frame), mode toggle,
  fps/latency readout.
- `src/control/`: canvas mouse + keyboard capture, normalize coords, throttle mousemove,
  send messages.
- `src/autotype-panel/`: textarea + profile controls + trigger + progress display.
- `src/App.tsx`, `src/main.tsx`, minimal styling.

## Phase 4 — Integration, docs, verification
- Root README: setup, run agent, run client, LAN vs Tailscale, OS permission notes.
- `npm run build` all packages; run test suites; typecheck.
- Manual-test checklist doc.

## Test strategy
- TDD where practical for pure logic (shared schemas, autotyper timing, coord math).
- Integration test for the agent WS + a node WS client.
- nut-js and screenshot-desktop mocked in unit tests (OS-dependent).
