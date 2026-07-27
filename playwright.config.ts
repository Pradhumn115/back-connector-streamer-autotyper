import { defineConfig, devices } from "@playwright/test";

/**
 * Browser-facing end-to-end tests. Separate from the workspaces' node:test
 * suites, which cover the agent and client in isolation; these drive a real
 * browser against a real agent.
 *
 * `ignoreHTTPSErrors` is required, not a convenience: the agent serves WSS with
 * a self-signed certificate it generates itself, so every connection a browser
 * makes to it — page load and WebSocket alike — fails without this.
 *
 * Both projects run the same spec, because codec negotiation is
 * answerer's-choice and each engine selects a different tier from
 * webrtc/codecs.ts: Chromium takes High, WebKit (Safari's engine) takes
 * Constrained Baseline. Running only one leaves an entire encoder path
 * untested, which is how the baseline tier shipped undecodable while Chromium
 * was fine.
 *
 * Serial, single worker: the agent binds a fixed port and captures the one
 * physical screen, so parallel runs would fight over both.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  reporter: [["list"]],
  use: {
    ignoreHTTPSErrors: true,
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    {
      name: "firefox",
      use: {
        ...devices["Desktop Firefox"],
        // Firefox hides local IPs behind mDNS ".local" ICE candidates unless the
        // page has been granted a media permission. This client is receive-only
        // and never asks for one, so those candidates arrive unresolvable and
        // ICE fails outright — the agent has no mDNS resolver. Disabling the
        // obfuscation here isolates the codec path, which is what this suite is
        // for; the underlying limitation is real and tracked separately.
        firefoxUserPrefs: { "media.peerconnection.ice.obfuscate_host_addresses": false },
      },
    },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
});
