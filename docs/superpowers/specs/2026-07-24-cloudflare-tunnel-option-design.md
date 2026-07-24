# Cloudflare Tunnel access option — design

## Problem

The agent is reachable over LAN (`192.168.x.x`) and Tailscale (`100.x.y.z`).
Neither covers the case where:

- both machines can't share a Tailscale tailnet, and
- the agent sits behind **double NAT** — a router in *router* mode nested inside
  a larger LAN — where port-forwarding either isn't possible or isn't allowed.

In that topology the agent's private IP is unroutable from outside its own
subnet, so there's no address to hand the client.

## Approach

Add a **Cloudflare Tunnel** as a third connection path. `cloudflared` runs on
the agent machine and makes an **outbound** connection to Cloudflare's edge,
which then proxies inbound client traffic back down that connection — no inbound
port, no bridge mode, works through NAT like any browser request.

Default to a **quick tunnel** (`cloudflared tunnel --url …`) which needs no
Cloudflare account or domain and yields a random `*.trycloudflare.com` URL.
Named tunnels (stable URL, requires a domain) are documented but not scripted.

Rejected alternative: making the agent itself dial out / embedding a tunnel
client. That couples the agent to a specific provider and contradicts the
existing "agent never opens a public socket" property. Keeping `cloudflared` a
separate, user-launched process preserves that property.

## Components

1. **`scripts/tunnel.mjs`** (+ `npm run tunnel`)
   - Resolves the agent port from `BCSA_PORT`, else `agent/.data/config.json`,
     else `8443`.
   - Verifies `cloudflared` is installed; if not, prints per-OS install help and
     exits non-zero.
   - Spawns `cloudflared tunnel --url https://localhost:<port> --no-tls-verify`
     with inherited stdio (so the user sees the printed URL), forwarding
     SIGINT/SIGTERM.
   - `--no-tls-verify` is safe: the only unverified hop is `cloudflared` →
     `localhost`, over loopback.

2. **Client connection (`client/src/connect/useConnection.ts`)**
   - `ConnectParams` gains `tunnelAddress`.
   - `normalizeTarget()` strips any pasted scheme (`https://`, `wss://`, …) and
     trailing slashes, then prepends `wss://`. Cloudflare prints `https://…/`, so
     this makes the field forgiving.
   - `buildTargets()` returns LAN → Tailscale → Tunnel (fastest to slowest),
     skipping blanks. The existing per-target timeout + fallback loop already
     handles trying each in order.
   - Persistence (localStorage load/save) includes the new field.

3. **Client UI (`client/src/App.tsx`)**
   - A third optional "Tunnel host" input, seeded from and saved to params.

## Data flow

```
Client browser ──wss──▶ Cloudflare edge (real TLS cert)
                              │  re-encrypt
                              ▼
                    cloudflared (agent host) ──wss (self-signed)──▶ agent :8443
```

The client tries LAN, then Tailscale, then the tunnel URL; the first socket to
open and authenticate wins.

## Security implications (documented in README)

- On the tunnel path Cloudflare terminates TLS with its **own trusted cert**, so
  the self-signed **fingerprint pinning does not apply** there. The **shared
  secret remains the sole gate**.
- A quick tunnel is **publicly reachable by URL**; the URL is unguessable but the
  agent controls a real keyboard/mouse, so this is a genuine exposure surface.
  Mitigations: strong secret, stop the tunnel when idle, Cloudflare Access for
  anything past personal use.
- The agent still never opens a public socket itself — unchanged.

## Testing / verification

- `npm run typecheck` and `npm run build` for the client changes (no new runtime
  logic beyond string handling; `normalizeTarget` is pure and simple).
- Manual: run agent, `npm run tunnel`, paste the printed host into the client,
  confirm connect + a frame arrives.
- No changes to the shared wire protocol, so existing shared/agent tests are
  unaffected.

## Out of scope (YAGNI)

- Named-tunnel automation / config generation (documented only).
- Cloudflare Access wiring (documented as the hardening path).
- Auto-detecting the tunnel URL into the client (quick-tunnel URLs are ephemeral;
  copy-paste is fine for personal use).
