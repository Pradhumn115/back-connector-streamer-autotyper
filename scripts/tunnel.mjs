// Exposes the locally-running agent over a Cloudflare Tunnel so a client on a
// different network can reach it without port-forwarding or a VPN. Cloudflare
// terminates TLS with its own trusted cert, so the client connects over a
// browser-trusted wss:// URL (no self-signed cert to accept). The agent's
// shared secret remains the only gate; the agent itself never opens a public
// socket — cloudflared makes the outbound connection to Cloudflare's edge.
//
// Usage: npm run tunnel            (quick tunnel, random *.trycloudflare.com URL)
//        BCSA_PORT=9000 npm run tunnel
//
// Requires cloudflared: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Resolve the agent's port: BCSA_PORT wins, else its persisted config, else 8443. */
function resolvePort() {
  if (process.env.BCSA_PORT) return Number(process.env.BCSA_PORT);
  const configPath = join(__dirname, "..", "agent", ".data", "config.json");
  if (existsSync(configPath)) {
    try {
      const cfg = JSON.parse(readFileSync(configPath, "utf8"));
      if (cfg.port) return Number(cfg.port);
    } catch {
      // Fall through to the default if the config is unreadable/corrupt.
    }
  }
  return 8443;
}

/** True if the `cloudflared` binary is on PATH. */
function cloudflaredInstalled() {
  const probe = spawnSync("cloudflared", ["--version"], { stdio: "ignore" });
  return !probe.error;
}

function printInstallHelp() {
  const plat = process.platform;
  console.error("❌ cloudflared is not installed (or not on your PATH).\n");
  console.error("Install it:");
  if (plat === "darwin") {
    console.error("  brew install cloudflared");
  } else if (plat === "win32") {
    console.error("  winget install --id Cloudflare.cloudflared");
  } else {
    console.error("  See https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/");
  }
  console.error("\nThen run `npm run tunnel` again.");
}

function main() {
  if (!cloudflaredInstalled()) {
    printInstallHelp();
    process.exit(1);
  }

  const port = resolvePort();
  const origin = `https://localhost:${port}`;

  console.log(`Starting Cloudflare quick tunnel → ${origin}`);
  console.log("Watch for the https://<random>.trycloudflare.com URL below,");
  console.log("then paste that hostname into the client's \"Tunnel host\" field.\n");

  // Force cloudflared to ignore any existing ~/.cloudflared/config.yml. If the
  // user has a named tunnel configured there, its `ingress:` rules (often a
  // `service: http_status:404` catch-all) OVERRIDE our --url and make every
  // request 404. Pointing --config at an empty file gives us a clean quick
  // tunnel that honours --url.
  const emptyConfig = join(tmpdir(), "bcsa-cloudflared-empty.yml");
  writeFileSync(emptyConfig, "# intentionally empty: forces a clean quick tunnel\n");

  const child = spawn(
    "cloudflared",
    [
      "tunnel",
      "--config",
      emptyConfig,
      // Prefer HTTP/2 (TCP 7844) over the default QUIC (UDP 7844): many
      // networks — exactly the restrictive/NAT'd ones this tunnel exists to
      // escape — block outbound UDP, leaving QUIC stuck retrying forever.
      "--protocol",
      "http2",
      "--url",
      origin,
      // --no-tls-verify: the agent's origin cert is self-signed; this hop is to
      //   localhost, so skipping verification here is safe.
      "--no-tls-verify",
    ],
    { stdio: "inherit" },
  );

  const forward = (sig) => () => child.kill(sig);
  process.on("SIGINT", forward("SIGINT"));
  process.on("SIGTERM", forward("SIGTERM"));
  child.on("exit", (code) => process.exit(code ?? 0));
}

main();
