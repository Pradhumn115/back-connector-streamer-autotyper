import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import WebSocket from "ws";
import selfsigned from "selfsigned";
import {
  decodeFrame,
  encodeMessage,
  isFrame,
  parseAgentMessage,
  FrameFormat,
  type AgentMessage,
} from "@bcsa/shared";
import { ConnectionServer } from "./index.js";
import { AudioCapture } from "../audio/index.js";
import { CaptureLoop, type CapturedImage } from "../capture/index.js";
import { InputController, type InputBackend } from "../input/index.js";
import type { TypingBackend } from "../autotyper/index.js";
import { InputLockManager } from "../inputlock/index.js";

function ephemeralTls(): { cert: string; key: string } {
  const pems = selfsigned.generate([{ name: "commonName", value: "test" }], {
    days: 1,
    keySize: 2048,
  });
  return { cert: pems.cert, key: pems.private };
}

function fakeCapture(stopCalls?: { count: number }): CaptureLoop {
  const image: CapturedImage = { data: new Uint8Array([1, 2, 3, 4]), format: FrameFormat.JPEG };
  const capture = new CaptureLoop(async () => image, 30);
  if (stopCalls) {
    const origStop = capture.stop.bind(capture);
    capture.stop = () => {
      stopCalls.count++;
      origStop();
    };
  }
  return capture;
}

function fakeInput(recorded: string[]): InputController {
  const backend: InputBackend = {
    async screenSize() {
      return { width: 1000, height: 500 };
    },
    async moveMouse(x, y) {
      recorded.push(`move(${x},${y})`);
    },
    async mouseButton(action, button) {
      recorded.push(`button(${action},${button})`);
    },
    async scroll() {},
    async keyAction(action, key) {
      recorded.push(`key(${action},${key})`);
    },
  };
  return new InputController(backend);
}

function fakeTyping(): TypingBackend {
  return { async typeChar() {}, async backspace() {} };
}

function fakeInputLock(): InputLockManager {
  return new InputLockManager({
    backend: { supported: false, async lock() {}, async unlock() {} },
    autoReleaseMs: 10_000,
    onChange: () => {},
  });
}

async function startServer(
  secret: string,
  recorded: string[],
  opts: { captureStopCalls?: { count: number }; maxQueuedFrameBytes?: number } = {},
) {
  const server = new ConnectionServer({
    secret,
    nickname: "test-agent",
    port: 0,
    host: "127.0.0.1",
    tls: ephemeralTls(),
    input: fakeInput(recorded),
    capture: fakeCapture(opts.captureStopCalls),
    typingBackend: fakeTyping(),
    inputLock: fakeInputLock(),
    audio: new AudioCapture(null), // no loopback device -> supported:false, no ffmpeg
    refreshHz: 60,
    maxQueuedFrameBytes: opts.maxQueuedFrameBytes,
  });
  await server.listen();
  return server;
}

/** Collect the next JSON AgentMessage of a given type. */
function nextMessage(ws: WebSocket, type: AgentMessage["type"]): Promise<AgentMessage> {
  return new Promise((resolve) => {
    const onMsg = (data: WebSocket.RawData, isBinary: boolean) => {
      if (isBinary) return;
      const msg = parseAgentMessage(data.toString());
      if (msg.type === type) {
        ws.off("message", onMsg);
        resolve(msg);
      }
    };
    ws.on("message", onMsg);
  });
}

test("full connect → auth → agentInfo → frame → control", async () => {
  const recorded: string[] = [];
  const server = await startServer("s3cret", recorded);
  const port = server.boundPort();

  const ws = new WebSocket(`wss://127.0.0.1:${port}`, { rejectUnauthorized: false });
  await once(ws, "open");

  const infoPromise = nextMessage(ws, "agentInfo");
  ws.send(encodeMessage({ type: "auth", secret: "s3cret" }));

  const info = await infoPromise;
  assert.equal(info.type, "agentInfo");
  if (info.type === "agentInfo") {
    assert.equal(info.screenWidth, 1000);
    assert.equal(info.nickname, "test-agent");
  }

  // Wait for a binary frame.
  const frame = await new Promise<Uint8Array>((resolve) => {
    const onMsg = (data: WebSocket.RawData, isBinary: boolean) => {
      if (!isBinary) return;
      const bytes = new Uint8Array(data as Buffer);
      if (isFrame(bytes)) {
        ws.off("message", onMsg);
        resolve(bytes);
      }
    };
    ws.on("message", onMsg);
  });
  const decoded = decodeFrame(frame);
  assert.ok(decoded);
  assert.deepEqual(Array.from(decoded!.payload), [1, 2, 3, 4]);

  // Send a click and verify the input backend received translated coords.
  ws.send(encodeMessage({ type: "mouse", action: "click", x: 0.5, y: 0.5, button: "left" }));
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(recorded.includes("move(500,250)"));
  assert.ok(recorded.includes("button(click,left)"));

  ws.close();
  await server.close();
});

test("rejects an invalid secret", async () => {
  const server = await startServer("right", []);
  const port = server.boundPort();
  const ws = new WebSocket(`wss://127.0.0.1:${port}`, { rejectUnauthorized: false });
  await once(ws, "open");

  const resultPromise = nextMessage(ws, "authResult");
  ws.send(encodeMessage({ type: "auth", secret: "wrong" }));
  const result = await resultPromise;
  assert.equal(result.type, "authResult");
  if (result.type === "authResult") {
    assert.equal(result.ok, false);
    assert.equal(result.reason, "invalid secret");
  }
  await server.close();
});

test("rejects a second concurrent controller as busy", async () => {
  const server = await startServer("k", []);
  const port = server.boundPort();

  const a = new WebSocket(`wss://127.0.0.1:${port}`, { rejectUnauthorized: false });
  await once(a, "open");
  const aInfo = nextMessage(a, "agentInfo");
  a.send(encodeMessage({ type: "auth", secret: "k" }));
  await aInfo;

  const b = new WebSocket(`wss://127.0.0.1:${port}`, { rejectUnauthorized: false });
  await once(b, "open");
  const bResult = nextMessage(b, "authResult");
  b.send(encodeMessage({ type: "auth", secret: "k" }));
  const result = await bResult;
  assert.equal(result.type === "authResult" && result.reason, "busy");

  a.close();
  b.close();
  await server.close();
});

/**
 * Backpressure: Classic frames must be DROPPED, not queued, once the socket is
 * behind.
 *
 * Classic is MJPEG, so every frame is a full intra frame — measured at ~267KB
 * at 1920 wide, which is ~206 Mbit/s at the 120fps the client requests on a
 * 120Hz display. No WiFi or Tailscale link carries that, and with no ceiling ws
 * simply queued the surplus in memory: the backlog grew every second and the
 * picture fell permanently behind real time. That was the "Classic lags after
 * 10-15s" symptom — nothing was being dropped, and that was the bug.
 *
 * A loopback socket drains far too fast to build a real backlog on demand, so
 * the threshold is moved instead: at -1, `bufferedAmount > -1` is always true
 * and every frame must take the drop path. The control channel is exercised
 * afterwards to prove the connection is still healthy — i.e. that frames were
 * deliberately dropped rather than the session being broken.
 */
test("drops Classic frames instead of queueing them when the socket is behind", async () => {
  const recorded: string[] = [];
  const server = await startServer("s3cret", recorded, { maxQueuedFrameBytes: -1 });
  const port = server.boundPort();

  const ws = new WebSocket(`wss://127.0.0.1:${port}`, { rejectUnauthorized: false });
  await once(ws, "open");

  const infoPromise = nextMessage(ws, "agentInfo");
  ws.send(encodeMessage({ type: "auth", secret: "s3cret" }));
  await infoPromise;

  let frames = 0;
  ws.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
    if (isBinary && isFrame(new Uint8Array(data as Buffer))) frames++;
  });

  // Comfortably longer than the 30fps fake capture's interval, so a working
  // send path would have delivered many frames by now.
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(frames, 0, `expected every frame to be dropped, got ${frames}`);

  // The session must still be alive — dropping frames is not disconnecting.
  ws.send(encodeMessage({ type: "mouse", action: "click", x: 0.5, y: 0.5, button: "left" }));
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(recorded.includes("button(click,left)"), "control channel should still work");

  ws.close();
  await server.close();
});
