# Back Connector — Streamer + Autotyper

> ## ⚠️ Authorized use only
> This tool streams a machine's screen and remotely controls its keyboard and
> mouse. **Run it only on machines you personally own, or ones you have explicit
> permission to control.** Using it to access someone else's device without their
> consent is illegal in most places. It is built for legitimate personal remote
> access — it has **no stealth, hiding, or evasion features** by design, and it
> always shows a visible cert prompt and requires a shared secret. You are
> responsible for how you use it.

A personal remote-control tool for machines you own. Run the **agent** on the
machine you want to control; open the **client** (a web app) on another device to
view its screen, control its mouse/keyboard, and run a human-like autotyper.

- **No relay server, no VPS.** The client connects directly to the agent.
- **LAN:** works with zero extra software — connect to the agent's `192.168.x.x`.
- **Remote (your own devices):** install [Tailscale](https://tailscale.com) on
  both machines and connect to the agent's `100.x.y.z` address.
- **Remote (no VPN, behind double NAT):** run a
  [Cloudflare Tunnel](#remote-access-via-cloudflare-tunnel) with `npm run tunnel`
  and connect to the `*.trycloudflare.com` URL it prints.

## Features

- **Screen streaming, two transports:**
  - **Classic** — JPEG frames over the WebSocket. *Screenshot* mode
    (low-frequency, low-bandwidth) or *Video* mode, which **auto-targets the
    agent's display refresh rate** (30 / 60 / up to 120 fps) via a continuous
    ffmpeg pipeline. Simple and robust; higher bandwidth.
  - **WebRTC** — a real peer connection (**H.264 video + Opus audio**, agent side
    via `werift` + ffmpeg RTP). Lower latency and bandwidth over the internet.
    Toggle Classic ⇄ WebRTC in the client; on any WebRTC error it falls back to
    Classic (no silent failure). The offer lists multiple H.264 quality tiers,
    so each browser negotiates the best one it actually supports — full
    native-resolution/high-fps on Chrome/Edge, falling back to a universal
    baseline profile on Safari and anything else, instead of one fixed codec
    breaking one browser or another. Playing the agent's audio out loud is a
    separate, off-by-default toggle (🔊/🔇) next to the video — independent of
    live transcription, which taps the same track regardless.
- **Remote control** — mouse and keyboard forwarded to the agent, mapped 1:1
  (click, double-click, right-click, drag) with resolution-independent
  coordinates.
- **Human-like autotyper** — types a block of text with adjustable cadence
  (base delay, jitter, occasional typo+correction), and can be **cancelled
  mid-run**.
- **Lock agent's local input** — block the physical keyboard/mouse at the agent
  so only the client drives it (with auto-release failsafes).
- **Audio transcription** — a live text transcript of whatever is playing on the
  agent, produced by **Whisper running in your browser** (audio never leaves the
  client).
- **Diagnostics panel** — one click self-checks both the browser and the agent
  (connection, ffmpeg, capture engine, permissions, input-lock, audio device)
  and tells you exactly how to fix anything that's wrong.
- **Direct & encrypted** — one TLS WebSocket (`wss://`), a shared secret, and no
  relay/VPS. Works over LAN, Tailscale, or a Cloudflare Tunnel.

> **Transport note:** the default **Classic** path is JPEG frames over the
> WebSocket — simple, robust, and fast enough to hit your display's refresh rate
> on LAN. Switch to **WebRTC** (H.264 + Opus) for lower latency and bandwidth,
> which matters most over the internet. Both are selectable in the client.

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

## Quick start (recommended) — the launcher

The easiest way on any machine is the interactive launcher. It **auto-detects
what's missing and sets it up** (installs dependencies, prerequisites, and
builds), then shows a menu to run what you want:

```bash
npm install    # once, to get the launcher's own deps
npm start      # or: node launch.mjs
```

On first run it installs/builds automatically if needed, then presents:

```
  1  Full setup        install deps + prerequisites + build
  2  Run agent         this machine gets controlled + streamed
  3  Run client        control another machine from your browser
  4  Run tunnel        expose the agent over Cloudflare (remote)
  5  Rebuild           recompile all packages
  6  Local test        agent + client on this machine
  q  Quit
```

Pick **2** on the machine you want to control and **3** on the machine you're
controlling from. Ctrl-C stops the running task and returns you to the menu.

> The launcher just orchestrates the individual `npm run …` scripts below — use
> those directly if you prefer.

## Setup (manual)

If you'd rather run the steps yourself instead of the launcher:

```bash
npm install          # installs all workspaces
npm run setup        # auto-installs prerequisites (ffmpeg, cloudflared) per-OS
npm run build        # builds shared, agent, client
```

`npm run setup` installs the agent's optional prerequisites using whatever
package manager the OS has (Homebrew on macOS; winget/choco/scoop on Windows;
apt/dnf/pacman on Linux):

- **ffmpeg** — enables high-fps screen capture **and the WebRTC transport** (its
  H.264/Opus RTP relays). Without it the agent falls back to a slow per-frame
  path (a few fps) and WebRTC is unavailable. **On Windows this is the fix for
  low video fps.** After it installs on Windows, open a NEW terminal so PATH
  updates, then `npm run agent`. (WebRTC's `werift` needs no system install — it
  comes with `npm install`.)
- **cloudflared** — optional, only needed for `npm run tunnel` (remote access
  without a VPN).

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

1. Enter the agent's **LAN address** (e.g. `192.168.0.119:8443`) and, if you'll
   connect remotely, its **Tailscale address** and/or **Tunnel host** too.
2. Enter the **secret** from the agent banner.
3. **Accept the agent's certificate first (LAN/Tailscale only).** Because the
   agent uses a self-signed cert, a browser will *silently refuse* the `wss://`
   connection until you've trusted it — and the WebSocket never shows a prompt.
   So before connecting, open the agent directly in a new browser tab:

   ```
   https://192.168.0.119:8443       ← the agent's IP + port, single https://
   ```

   You'll get a "Your connection is not private" warning — click **Advanced →
   Proceed / Continue** (in Chrome you can also just type `thisisunsafe`).
   Optionally verify the cert's SHA-256 matches the agent banner. When it works
   you'll see a **"✅ Agent reachable"** page — that confirms the cert is trusted
   *and* that the address is reachable.
4. Go back to the client and press **Connect**. It tries LAN first, then
   Tailscale, then the tunnel. (A Cloudflare **Tunnel** URL uses Cloudflare's own
   trusted cert, so it needs no cert-acceptance step — skip #3 for the tunnel.)

> **If Connect just spins:** it's almost always the cert (step 3 not done for
> that address) or the agent isn't reachable at that IP. Opening
> `https://<agent-ip>:8443` in a tab tells you which: a cert warning → do step 3;
> "can't reach this site" → wrong IP / network isolation (use the Ethernet or
> Tailscale address instead).

Then:

- **Screen view:** toggle *Screenshot* mode (low frequency) or *Video* mode,
  which auto-targets the agent's display refresh rate (up to 120 fps). The
  readout shows live fps, the target, and frame sequence.
- **Control:** enable control, then your mouse/keyboard over the canvas drives the
  agent (click, double-click, right-click, drag). Toggle it off to release.
- **Autotype:** paste text, tune the human-likeness (base delay, jitter, typo
  rate), click *Type it* — and hit *Cancel* to stop mid-run.
- **Lock agent's local input:** blocks the physical keyboard/mouse at the agent
  so only you (the client) drive it. See below.
- **Transcribe audio:** live text transcript of whatever is playing on the
  agent, produced by a speech model running in your browser. Both **Live**
  (continuous, VAD-gated) and **Record** (buffer a take, transcribe on pause)
  modes work identically under Classic and WebRTC. See below.
- **Diagnostics:** runs on connect (and on demand) — checks the connection,
  frames, ffmpeg, capture engine, permissions, input-lock, and audio device, and
  shows the fix for anything wrong. Includes a *Copy* button for the report.

## Locking the agent's local input

The client has a **"Lock agent's local input"** toggle. When on, the person
sitting at the agent machine can't interfere — only synthetic input from the
client gets through. The agent can also toggle it with the **Ctrl+Alt+L** hotkey
(when the optional `uiohook-napi` module is installed).

**You can never get permanently locked out.** The lock releases when any of these
happen:
- ~10 seconds pass with no client input (auto-release watchdog), or
- you toggle it off / disconnect the client, or
- the agent process exits.
On Windows, **Ctrl+Alt+Del** always bypasses the block as a final failsafe.

**OS support:** Real blocking is implemented on **Windows** (via the Win32
`BlockInput` API — no native build needed). On **macOS and Linux** it is **not
implemented yet**, so the agent reports the feature as unsupported and the client
disables the toggle — it never shows a false "locked" state. (Adding it needs a
native `CGEventTap` on macOS / `EVIOCGRAB` on Linux.)

> ⚠️ **Windows requires an elevated agent.** `BlockInput` is governed by
> Windows' UIPI: from a normal (non-elevated) process it is silently refused and
> blocks nothing. Start the agent from a terminal opened with **"Run as
> administrator"**. If the agent isn't elevated, the lock request fails cleanly —
> the client shows *not* locked plus a "run as Administrator" message, rather
> than a false lock.

## Transcribing the agent's audio

The client's **"Transcribe audio"** toggle captures whatever is playing on the
agent (system output) and turns it into a live text transcript. The speech model
(**Whisper**, via `@huggingface/transformers`) runs **entirely in your browser** —
the audio is transcribed locally and **never leaves the client**. Transcription
itself never plays audio; it only feeds the model. Under **WebRTC**, the video
element carries a separate, off-by-default 🔊/🔇 toggle if you actually want to
hear the agent's audio out loud — that's independent of transcription, which
taps the same track either way.

Both **Live** and **Record** modes work the same whether you're on Classic or
WebRTC — switching transport mid-session doesn't interrupt an active
transcription; it just keeps consuming whichever audio path is currently live.

**How it works:** the agent captures its loopback audio with ffmpeg as 16 kHz
mono PCM and streams it to the client, which resamples nothing (already Whisper's
native rate), buffers ~5 s windows, and transcribes each in a Web Worker so the
UI never blocks. WebGPU is used when available (Chrome/Edge 113+), falling back
to WASM. The model (~50 MB) downloads once on first use and is cached in the
browser.

**One-time agent setup — a loopback device.** Capturing *system output* ("what's
playing on the speakers") needs a virtual audio device. `npm run setup` installs
the driver for you; the routing step below is manual because macOS/Windows gate
audio drivers and output routing behind the GUI. **Linux needs nothing.**

The goal on every OS is the same: make app audio flow into a loopback device the
agent can read, **while you can still hear it**.

### Linux — nothing to do ✓

PulseAudio/PipeWire already exposes the default sink's `.monitor`. The agent
auto-detects it (`pactl get-default-sink`). Just enable **Transcribe audio** in
the client. (Ensure `pactl` is available — it ships with most desktop distros.)

### macOS — BlackHole + a Multi-Output Device

1. **Install the driver:** `npm run setup` (or `brew install blackhole-2ch`).
   Restart the Mac if BlackHole doesn't appear in step 3.
2. **Grant Microphone permission** to the app running the agent (Terminal/iTerm):
   *System Settings → Privacy & Security → Microphone* → enable it. macOS treats
   audio capture as microphone access, so without this ffmpeg records silence.
3. **Route audio so you still hear it** — open **Audio MIDI Setup**
   (`⌘ Space` → "Audio MIDI Setup"):
   1. Click **+** (bottom-left) → **Create Multi-Output Device**.
   2. In the right panel, tick **both** your speakers/headphones **and**
      **BlackHole 2ch**. Set your speakers as the top (primary) device, and tick
      **Drift Correction** on BlackHole.
   3. Right-click the new **Multi-Output Device** → **Use This Device For Sound
      Output** (or pick it in *System Settings → Sound → Output*).
4. Now anything you play goes to your speakers **and** to BlackHole. Enable
   **Transcribe audio** in the client. (To go back to normal, set Output back to
   your speakers.)

### Windows — VB-Cable + "Listen to this device"

1. **Install the driver:** `npm run setup` (or `choco install vb-cable`, or the
   installer from [vb-audio.com/Cable](https://vb-audio.com/Cable/)). Run it as
   Administrator and **reboot** if asked.
2. **Send app audio into the cable:** right-click the speaker icon → *Sound
   settings* → set **CABLE Input** as the **Output** device. (Now apps play into
   the cable — which is why you temporarily can't hear them; step 3 fixes that.)
3. **Hear it too:** *Sound settings → More sound settings* (opens `mmsys.cpl`) →
   **Recording** tab → **CABLE Output** → **Properties** → **Listen** tab → tick
   **Listen to this device** → choose your real speakers → **OK**.
4. The agent auto-detects **CABLE Output**. Enable **Transcribe audio** in the
   client. (To go back to normal, set Output back to your speakers and untick
   "Listen to this device".)

If no loopback device is found, the agent reports the feature **unsupported** and
the client **disables the toggle** with a hint — it never silently records
silence or waits on audio that will never come.

> ℹ️ v1 transcribes in ~5 s windows, so captions lag a few seconds. The design
> (`docs/superpowers/specs/`) notes a VAD-based segmenter as the low-latency
> improvement path.

### Audio troubleshooting

| Symptom | Cause & fix |
|---|---|
| **Toggle is greyed out** | No loopback device detected. Install it (`npm run setup`); on Windows reboot so the driver appears; then reconnect the client. |
| **Captions stay blank while audio plays** | The loopback isn't receiving the audio. macOS: make sure the **Multi-Output Device** is the current *Output* (System Settings → Sound). Windows: set **CABLE Input** as the *Output* device. |
| **macOS: still blank after routing** | Terminal lacks **Microphone** permission — grant it (Privacy & Security → Microphone) and restart the agent. |
| **You can't hear anything anymore** | You routed audio into the loopback but not back to your speakers. macOS: the Multi-Output Device must include your speakers. Windows: enable **Listen to this device** on *CABLE Output* → your speakers. |
| **Captions lag ~5 s** | Expected — v1 transcribes in 5 s windows. |
| **First use is slow / "loading model"** | The ~50 MB Whisper model downloads once, then it's cached in the browser. |
| **Wrong language / gibberish** | Whisper auto-detects language per window; very short or noisy clips transcribe poorly. |

## Remote access via Cloudflare Tunnel

If both machines can't be on a Tailscale tailnet — e.g. the agent is behind
double NAT (a router in *router* mode inside a larger LAN) where you can't port
forward — a Cloudflare Tunnel reaches it without any inbound network changes.
`cloudflared` dials **outbound** to Cloudflare's edge, so it works through NAT
and firewalls the same way a browser does.

**One-time:** install `cloudflared`
(`brew install cloudflared` / `winget install --id Cloudflare.cloudflared` /
[other platforms](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)).

**Each session**, with the agent already running:

```bash
npm run tunnel
```

It prints a line like `https://random-words.trycloudflare.com`. Put that
hostname in the client's **Tunnel host** field (scheme and trailing slash are
optional — `random-words.trycloudflare.com` is enough), then Connect. The secret
still gates the connection.

> ℹ️ Quick tunnels get a **new random URL every run**. For a stable hostname,
> set up a [named tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/create-remote-tunnel/)
> with your own Cloudflare domain and point its ingress at
> `https://localhost:8443` with `noTLSVerify: true`.

> ⚠️ A tunnel makes the agent reachable by **anyone who has the URL** (only the
> shared secret stops them). For a control tool this is a real exposure surface —
> keep the secret strong, stop the tunnel (`Ctrl+C`) when you're done, and for
> anything beyond personal use put [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/)
> in front of it.

## Security model (Basic tier)

- TLS (`wss://`) on all connections.
  - **LAN / Tailscale:** the agent's self-signed cert is pinned by fingerprint —
    verify the printed SHA-256 on first connect.
  - **Cloudflare Tunnel:** Cloudflare terminates TLS with its own trusted cert,
    so fingerprint pinning does not apply on that path; the shared secret is the
    gate, and traffic is re-encrypted from Cloudflare's edge to the agent.
- A shared secret gates every connection; one controller at a time.
- The agent binds LAN/Tailscale interfaces only — never a public internet socket.
  A tunnel does not change this: `cloudflared` connects to the agent locally and
  makes the outbound edge connection itself.
- Not included by design: audit logging, remote session revocation, brute-force
  rate limiting. Fine for personal use; harden before any multi-user use, and
  prefer Tailscale or Cloudflare Access over a bare quick tunnel.

## Development

```bash
npm test                          # shared + agent unit/integration tests
npm run typecheck                 # typecheck all workspaces
npm run build                     # build all workspaces
```

## If Classic video feels laggy

Classic video is JPEG-frames-over-WebSocket — simple and robust, but heavier on
bandwidth (a 120fps stream is ~85 Mbps), which is fine on LAN/Tailscale but a lot
over the internet. If it feels laggy, **switch the transport to WebRTC** in the
client: it uses a real peer connection with H.264 video + Opus audio (agent side
via `werift` + ffmpeg RTP), so it adapts bitrate and stays low-latency over
constrained links. On any WebRTC failure the client falls back to Classic and
shows the error rather than freezing.

### WebRTC troubleshooting

| Symptom | Cause & fix |
|---|---|
| **Toggle flips back to Classic** | WebRTC couldn't establish — the client never fails silently. Check the error hint, then the rows below. |
| **Agent diagnostics: "WebRTC unavailable"** | The RTP relay needs **ffmpeg** on the agent. Run `npm run setup` and restart the agent. |
| **"Browser WebRTC" warns in diagnostics** | Your browser lacks `RTCPeerConnection`. Use a modern browser; Classic mode still works. |
| **Black video after switching** | Codec negotiation or the peer connection failed to complete. It should auto-revert to Classic; if not, toggle back and retry. Very restrictive networks can block the peer connection (STUN/ICE) — use Classic there. |
| **Video works, no audio (or vice-versa)** | One track's codec (H.264 / Opus) didn't negotiate. Retry the toggle; check the agent log for a codec-negotiation error. |
| **Windows: `Failed to capture image (error 5)` in the agent log** | `gdigrab` (the default Windows capture) is refused by Windows whenever a **secure desktop** is showing — a UAC prompt, the lock screen, or Ctrl+Alt+Del — and it exits rather than recovering. The agent now respawns it automatically (4 tries with backoff), so a passing UAC prompt no longer ends the stream. If it fails *persistently*, switch capture backends: see below. |

#### Windows: switching to the `ddagrab` capture backend

`gdigrab` uses the old GDI path and cannot capture a secure desktop or a
fullscreen-exclusive window. `ddagrab` uses the Desktop Duplication API
(DXGI), reads from the GPU, and handles both. It needs **Windows 8+**, a
**64-bit ffmpeg**, and a build with the filter compiled in — which is why it
is opt-in rather than the default.

First check your ffmpeg actually has it (this should show a live capture and
exit after 5 seconds):

```
ffmpeg -f lavfi -i ddagrab=output_idx=0:framerate=30 -t 5 -vf hwdownload,format=bgra -f null -
```

If that works, start the agent with the backend selected:

```powershell
$env:BCSA_WIN_CAPTURE="ddagrab"; npm run agent
```

Both Classic and WebRTC pick it up. Unset it (or set anything else) to go back
to `gdigrab`.
