# Back Connector — Streamer + Autotyper

A personal remote-control tool for machines you own. Run the **agent** on the
machine you want to control; open the **client** (a web app) on another device to
view its screen, control its mouse/keyboard, and run a human-like autotyper.

- **No relay server, no VPS.** The client connects directly to the agent.
- **LAN:** works with zero extra software — connect to the agent's `192.168.x.x`.
- **Remote (different networks):** install [Tailscale](https://tailscale.com) on
  both machines and connect to the agent's `100.x.y.z` address.

> ⚠️ This controls a real machine's keyboard, mouse, and screen. Only run it on
> machines you own or are authorized to control. It has no stealth features by
> design.

## Layout

```
shared/   TypeScript wire protocol (zod schemas) + binary frame codec
agent/    runs on the controlled machine (screen capture, input injection, autotyper)
client/   web app (React + Vite): view screen, control, autotype panel
```

## Prerequisites

- Node.js 20+ (built with 24).
- **macOS:** the first time the agent injects input / captures the screen, grant
  the terminal (or the app running node) permission under
  *System Settings → Privacy & Security → Screen Recording* and *Accessibility*.
- **Linux:** X11 session recommended (Wayland input injection is limited).
  `screenshot-desktop` may require ImageMagick installed.
- **Windows:** works out of the box.

## Setup

```bash
npm install          # installs all workspaces
npm run build        # builds shared, agent, client
```

## Run the agent (on the machine to control)

```bash
npm run agent
```

On first run it generates a config (`agent/.data/config.json`) with a random
shared secret and a self-signed TLS certificate, then prints a banner:

```
  Port:        8443
  Secret:      <your-secret>
  Cert SHA-256:AB:CD:...
  Connect from the client using one of:
    LAN:       192.168.1.20:8443
    Tailscale: 100.101.102.103:8443
```

Override via env vars: `BCSA_PORT`, `BCSA_SECRET`, `BCSA_NICKNAME`.

## Run the client (on your controlling device)

```bash
npm run client       # starts Vite dev server (http://localhost:5173)
```

In the client:

1. Enter the agent's **LAN address** (e.g. `192.168.1.20:8443`) and, if you'll
   connect remotely, its **Tailscale address** too.
2. Enter the **secret** from the agent banner.
3. Connect. The browser will warn about the self-signed certificate the first
   time — that's expected; verify it matches the agent's printed SHA-256
   fingerprint, then proceed. The client tries the LAN address first and falls
   back to Tailscale.

Then:

- **Screen view:** toggle between *Screenshot* mode (low frequency) and *Video*
  mode (higher frequency JPEG frames).
- **Control:** enable control, then your mouse/keyboard over the canvas drives the
  agent. Toggle it off to release control.
- **Autotype:** paste text, tune the human-likeness (base delay, jitter, typo
  rate), and click *Type it*.

## Security model (Basic tier)

- TLS (`wss://`) on all connections; the agent's self-signed cert is pinned by
  fingerprint. Verify the fingerprint on first connect.
- A shared secret gates every connection; one controller at a time.
- The agent binds LAN/Tailscale interfaces only — never a public internet socket.
- Not included by design: audit logging, remote session revocation, brute-force
  rate limiting. Fine for personal use; harden before any multi-user use.

## Development

```bash
npm test                          # shared + agent unit/integration tests
npm run typecheck                 # typecheck all workspaces
npm run build                     # build all workspaces
```

## If video mode feels laggy

The video path is JPEG-frames-over-WebSocket, not WebRTC — simple and robust, but
heavier on bandwidth. If latency is unacceptable, the design (see
`docs/superpowers/specs/`) documents swapping in a WebRTC video transport
(`werift`) or an `ffmpeg`-based capture pipeline without changing the rest of the
architecture.
