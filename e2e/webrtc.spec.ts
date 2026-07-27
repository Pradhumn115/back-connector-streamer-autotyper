import { test, expect, type Page } from "@playwright/test";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { join } from "node:path";

/**
 * End-to-end proof that a browser can actually DECODE what the agent sends.
 *
 * Every other test in this repo inspects the encoder's output — profile,
 * slice count, level conformance, RTP timestamps. All of them passed while the
 * stream was completely undecodable in a real browser, three separate times and
 * for three different reasons (a profile the SDP did not match, multi-slice
 * frames, and a level the frame size violated). Each looked identical from the
 * agent: RTP flowing, session "connected", picture blank.
 *
 * The distinguishing signal is on the receiver, and only there. A black <video>
 * looks the same whether ICE failed, DTLS failed, the decoder rejected the
 * profile, or the frame broke the level — but "frames are being decoded" is
 * unambiguous. So this asserts on the decoder's own frame counter and nothing
 * else.
 *
 * Browser coverage is the point. Codec negotiation is answerer's-choice, so
 * each engine picks a different tier from webrtc/codecs.ts:
 *   - Chromium takes the High tier (payload 96).
 *   - WebKit — Safari's engine — cannot do High/5.2 and takes Constrained
 *     Baseline (payload 97).
 * Testing one engine therefore leaves an entire encoder configuration
 * unexercised, which is exactly how the baseline tier shipped broken while
 * Chromium worked.
 *
 * Requires a real screen-capture permission for the agent's ffmpeg, so this is
 * a local/desktop test rather than a headless-CI one.
 */

const AGENT_SECRET = "e2e-test-secret";
const REPO_ROOT = join(__dirname, "..");

/**
 * Ports are chosen per run rather than fixed.
 *
 * `tsx` runs the agent in a forked CHILD, so the pid we spawn is not the
 * process that holds the socket; a fixed port therefore stays occupied by any
 * stray agent from an earlier run and every subsequent run fails with
 * EADDRINUSE — a harness fault that looks exactly like a product fault.
 * Asking the OS for a free port each time sidesteps that entirely.
 */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

/** Kills whatever currently listens on a TCP port, including forked children. */
function killPort(port: number): void {
  try {
    execSync(`lsof -ti tcp:${port} | xargs kill -9`, { stdio: "ignore" });
  } catch {
    /* nothing listening */
  }
}

let AGENT_PORT = 0;
let CLIENT_PORT = 0;

let agent: ChildProcess | null = null;
let client: ChildProcess | null = null;

/** Waits until `predicate` sees a line of the child's output, or times out. */
function waitForOutput(proc: ChildProcess, predicate: (s: string) => boolean, timeoutMs: number) {
  return new Promise<void>((resolve, reject) => {
    let seen = "";
    const timer = setTimeout(
      () => reject(new Error(`timed out waiting for output. Got:\n${seen}`)),
      timeoutMs,
    );
    const onData = (chunk: Buffer) => {
      seen += chunk.toString();
      if (predicate(seen)) {
        clearTimeout(timer);
        resolve();
      }
    };
    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);
  });
}

test.beforeAll(async () => {
  AGENT_PORT = await freePort();
  CLIENT_PORT = await freePort();

  // detached: true puts each child in its own process group. npm spawns the
  // real work as a GRANDCHILD (`sh -c tsx src/index.ts`), so killing the npm
  // process alone leaves the agent alive and still holding the port — which
  // made the second browser project fail with EADDRINUSE rather than any real
  // defect. The group is torn down as a unit in afterAll.
  agent = spawn("npm", ["run", "start", "--workspace", "agent"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      BCSA_PORT: String(AGENT_PORT),
      BCSA_SECRET: AGENT_SECRET,
      // See screenCaptureInputArgs: the real screen needs an OS permission that
      // does not follow a test runner's process tree, and CI has no display at
      // all. What is under test is the transport and codec path, not where the
      // pixels came from.
      BCSA_FAKE_CAPTURE: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  await waitForOutput(agent, (s) => s.includes("agent is running"), 60_000);
  // Echo the agent's own log into the test output: when the browser fails to
  // decode, the reason is usually stated plainly on the agent side (keyframe
  // requests, encoder restarts, level violations) and is otherwise invisible.
  const echo = (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n")) {
      if (line.trim() && !/NSKVONotifying|Supported pixel|uyvy422|yuyv422|nv12|0rgb|bgr0/.test(line)) {
        // eslint-disable-next-line no-console
        console.log(`  [agent] ${line.trim()}`);
      }
    }
  };
  agent.stdout?.on("data", echo);
  agent.stderr?.on("data", echo);

  client = spawn("npx", ["vite", "--port", String(CLIENT_PORT), "--strictPort"], {
    cwd: join(REPO_ROOT, "client"),
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  await waitForOutput(client, (s) => s.includes("ready in") || s.includes("Local:"), 60_000);
});

test.afterAll(() => {
  // Negative pid kills the whole process group, reaching npm's grandchildren.
  for (const proc of [agent, client]) {
    if (!proc?.pid) continue;
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  // Belt and braces: tsx's forked child is not always in the group we killed,
  // and a survivor would hold the port against the next project.
  killPort(AGENT_PORT);
  killPort(CLIENT_PORT);
  agent = null;
  client = null;
});

/** Connects the client to the agent and switches it to the WebRTC transport. */
async function connectOverWebrtc(page: Page): Promise<void> {
  // Capture every RTCPeerConnection the app creates, before any app code runs.
  // getStats() is the only decode signal that is both standard and reliable
  // across engines — HTMLVideoElement.getVideoPlaybackQuality() reports 0 for
  // MediaStream sources in some browsers, which would misreport a perfectly
  // healthy stream as undecodable.
  await page.addInitScript(() => {
    const Native = window.RTCPeerConnection;
    (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs = [];
    window.RTCPeerConnection = function (...args: unknown[]) {
      const pc = new (Native as unknown as new (...a: unknown[]) => RTCPeerConnection)(...args);
      (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs.push(pc);
      return pc;
    } as unknown as typeof RTCPeerConnection;
    window.RTCPeerConnection.prototype = Native.prototype;
  });

  // Visiting the agent once accepts its self-signed certificate for this
  // context; without it the client's WSS connection is refused outright.
  await page.goto(`https://127.0.0.1:${AGENT_PORT}/`);
  await page.goto(`http://localhost:${CLIENT_PORT}/`);

  await page.getByRole("textbox", { name: "LAN host:port" }).fill(`127.0.0.1:${AGENT_PORT}`);
  await page.getByRole("textbox", { name: "secret" }).fill(AGENT_SECRET);
  await page.getByRole("button", { name: "Connect", exact: true }).click();

  const webrtcButton = page.getByRole("button", { name: "WebRTC" });
  await expect(webrtcButton).toBeEnabled({ timeout: 20_000 });
  await webrtcButton.click();
}

/**
 * Inbound video stats straight from the receiver.
 *
 * `framesDecoded` is the assertion that matters: it advances only when the
 * browser has genuinely decoded a frame, so a connected-but-blank stream cannot
 * satisfy it. `bytesReceived` is reported alongside because together they
 * partition the failure — bytes without frames means the decoder rejected the
 * stream (wrong profile, bad level, malformed packetisation), while no bytes at
 * all means it never arrived (ICE, DTLS, SRTP).
 */
async function inboundVideo(page: Page, windowMs: number) {
  return page.evaluate(async (ms) => {
    const pcs = (window as unknown as { __pcs?: RTCPeerConnection[] }).__pcs ?? [];
    const read = async () => {
      for (const pc of pcs) {
        for (const report of (await pc.getStats()).values()) {
          if (report.type === "inbound-rtp" && report.kind === "video") {
            return {
              framesDecoded: (report.framesDecoded as number) ?? 0,
              bytesReceived: (report.bytesReceived as number) ?? 0,
              width: (report.frameWidth as number) ?? 0,
              height: (report.frameHeight as number) ?? 0,
              decoder: (report.decoderImplementation as string) ?? "",
              pli: (report.pliCount as number) ?? 0,
            };
          }
        }
      }
      return null;
    };
    const before = await read();
    const started = performance.now();
    await new Promise((r) => setTimeout(r, ms));
    const after = await read();
    if (!before || !after) return { error: "no inbound-rtp video stats" as const };
    const seconds = (performance.now() - started) / 1000;
    return {
      decoded: after.framesDecoded - before.framesDecoded,
      fps: (after.framesDecoded - before.framesDecoded) / seconds,
      bytesDelta: after.bytesReceived - before.bytesReceived,
      width: after.width,
      height: after.height,
      decoder: after.decoder,
      pli: after.pli,
    };
  }, windowMs);
}

test("the browser decodes the agent's WebRTC video", async ({ page, browserName }) => {
  // Surface the browser's own complaints: a failed offer/answer shows up here
  // and nowhere on the agent, which never gets far enough to log anything.
  page.on("console", (m) => {
    if (m.type() === "error" || m.text().includes("WebRTC")) {
      // eslint-disable-next-line no-console
      console.log(`  [${browserName}:console] ${m.text()}`);
    }
  });
  page.on("pageerror", (e) => {
    // eslint-disable-next-line no-console
    console.log(`  [${browserName}:pageerror] ${e.message}`);
  });

  await connectOverWebrtc(page);

  // Allow for offer/answer, ICE, DTLS, and the encoder's first keyframe.
  // The last sample is retained so a failure can say WHY: bytes arriving with
  // no frames decoded means the decoder rejected the stream, whereas no bytes
  // at all means it never got there.
  // The last sample is retained so a failure can say WHY: bytes arriving with
  // no frames decoded means the decoder rejected the stream, whereas no bytes
  // at all means it never got there. Rethrown rather than passed as `message`,
  // which is evaluated once up front and would always report the initial null.
  let last: unknown = null;
  try {
    await expect
      .poll(
        async () => {
          last = await inboundVideo(page, 250);
          return (last as { decoded?: number }).decoded ?? 0;
        },
        { timeout: 30_000 },
      )
      .toBeGreaterThan(0);
  } catch {
    const diag = await page.evaluate(() => {
      const pcs = (window as unknown as { __pcs?: RTCPeerConnection[] }).__pcs ?? [];
      const video = document.querySelector("video");
      return {
        peerConnections: pcs.length,
        states: pcs.map((pc) => ({
          connection: pc.connectionState,
          ice: pc.iceConnectionState,
          signaling: pc.signalingState,
          receivers: pc.getReceivers().map((r) => r.track?.kind),
        })),
        hasVideoElement: !!video,
        videoSize: video ? `${video.videoWidth}x${video.videoHeight}` : null,
        bodyText: document.body.innerText.slice(0, 400),
      };
    });
    throw new Error(
      `no frames were ever decoded by ${browserName}.\n` +
        `Last inbound stats: ${JSON.stringify(last)}\n` +
        `Page diagnostics: ${JSON.stringify(diag, null, 2)}`,
    );
  }

  const stats = await inboundVideo(page, 3000);
  if ("error" in stats) throw new Error(stats.error);

  // eslint-disable-next-line no-console
  console.log(
    `[${browserName}] ${stats.decoded} frames in 3s (${stats.fps.toFixed(1)}fps) ` +
      `at ${stats.width}x${stats.height}, decoder=${stats.decoder || "n/a"}, ` +
      `${(stats.bytesDelta / 1024).toFixed(0)}KB received, pliCount=${stats.pli}`,
  );

  // A stream that decodes one keyframe and then stalls is still broken, so
  // require a sustained rate rather than merely a non-zero count.
  expect(stats.fps, "decoding stalled after starting").toBeGreaterThan(5);
  expect(stats.width, "decoded frames should have real dimensions").toBeGreaterThan(0);
});
