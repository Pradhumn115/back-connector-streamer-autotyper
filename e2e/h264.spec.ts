import { test, expect } from "@playwright/test";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { join } from "node:path";

const SECRET = "h264-e2e";
const ROOT = join(__dirname, "..");
let agent: ChildProcess | null = null, client: ChildProcess | null = null;
let AGENT_PORT = 0, CLIENT_PORT = 0;

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address() as { port: number }; s.close(() => res(port)); });
  });
}
function killPort(p: number) { try { execSync(`lsof -ti tcp:${p} | xargs kill -9`, { stdio: "ignore" }); } catch {} }
function waitFor(proc: ChildProcess, pred: (s: string) => boolean, ms: number) {
  return new Promise<void>((res, rej) => {
    let seen = "";
    const t = setTimeout(() => rej(new Error(`timeout. Got:\n${seen}`)), ms);
    const on = (c: Buffer) => { seen += c.toString(); if (pred(seen)) { clearTimeout(t); res(); } };
    proc.stdout?.on("data", on); proc.stderr?.on("data", on);
  });
}

test.beforeAll(async () => {
  AGENT_PORT = await freePort(); CLIENT_PORT = await freePort();
  agent = spawn("npm", ["run", "start", "--workspace", "agent"], {
    cwd: ROOT, detached: true, stdio: ["ignore", "pipe", "pipe"],
    // BCSA_H264_ENCODER is forwarded so the same suite can be run against a
    // specific encoder. Hardware and software emit different bitstreams, and
    // "the browser decodes it" has to be proved for whichever one ships —
    // a hardware encoder that produces an undecodable stream would otherwise
    // surface as a black screen with no error anywhere.
    // BCSA_H264 is deliberately NOT set: H.264 is the default path now, so the
    // suite should exercise what a user actually gets rather than a flag only
    // the test knows about. BCSA_H264_ENCODER is forwarded so the same suite can
    // be run against a specific encoder — hardware and software emit different
    // bitstreams, and "a browser decodes it" has to be proved for whichever
    // ships, since an undecodable stream shows up as a black screen with no
    // error anywhere.
    env: { ...process.env, BCSA_PORT: String(AGENT_PORT), BCSA_SECRET: SECRET },
  });
  await waitFor(agent, (s) => s.includes("agent is running"), 60_000);
  client = spawn("npx", ["vite", "--port", String(CLIENT_PORT), "--strictPort"], {
    cwd: join(ROOT, "client"), detached: true, stdio: ["ignore", "pipe", "pipe"],
  });
  await waitFor(client, (s) => s.includes("ready in") || s.includes("Local:"), 60_000);
});

test.afterAll(() => {
  for (const p of [agent, client]) { if (p?.pid) { try { process.kill(-p.pid, "SIGKILL"); } catch {} } }
  killPort(AGENT_PORT); killPort(CLIENT_PORT);
});

/**
 * Proves the browser DECODES the agent's H.264, not merely that bytes arrived.
 * Asserts on canvas pixels: a decoded frame paints the canvas, so a non-blank
 * canvas is only possible if WebCodecs produced a real VideoFrame.
 */
test("browser decodes the agent's H.264 screen stream", async ({ page, browserName }) => {
  page.on("console", (m) => { if (m.type() === "error") console.log(`  [${browserName}] ${m.text()}`); });
  await page.goto(`https://127.0.0.1:${AGENT_PORT}/`);
  await page.goto(`http://localhost:${CLIENT_PORT}/`);
  await page.getByRole("textbox", { name: "LAN host:port" }).fill(`127.0.0.1:${AGENT_PORT}`);
  await page.getByRole("textbox", { name: "secret" }).fill(SECRET);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByRole("button", { name: "Video" }).click();

  const painted = async () => page.evaluate(() => {
    const c = document.querySelector("canvas") as HTMLCanvasElement | null;
    if (!c || !c.width || !c.height) return { w: 0, h: 0, nonBlank: 0 };
    const d = c.getContext("2d")?.getImageData(0, 0, c.width, c.height).data;
    let nonBlank = 0;
    if (d) for (let i = 0; i < d.length; i += 4000) if (d[i] !== 0 || d[i + 1] !== 0 || d[i + 2] !== 0) nonBlank++;
    return { w: c.width, h: c.height, nonBlank };
  });

  await expect.poll(async () => (await painted()).nonBlank, { timeout: 30_000 }).toBeGreaterThan(0);
  const p = await painted();
  console.log(`[${browserName}] canvas ${p.w}x${p.h}, ${p.nonBlank} non-blank samples`);
  expect(p.w).toBeGreaterThan(0);
});
