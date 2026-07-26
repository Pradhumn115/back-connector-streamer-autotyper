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

function fakeWebrtcFfmpegArgs(): { video: (port: number) => string[]; audio: (port: number) => string[] } {
  return {
    video: () => ["-f", "lavfi", "-i", "nullsrc", "-t", "0.1", "-f", "null", "-"],
    audio: () => ["-f", "lavfi", "-i", "anullsrc", "-t", "0.1", "-f", "null", "-"],
  };
}

async function startServer(
  secret: string,
  recorded: string[],
  opts: { captureStopCalls?: { count: number } } = {},
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
    webrtcFfmpegArgs: fakeWebrtcFfmpegArgs(),
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

test("startWebrtc stops Classic capture (verified via stop-counter) and reports webrtcState", async () => {
  const captureStopCalls = { count: 0 };
  const server = await startServer("s3cret", [], { captureStopCalls });
  const port = server.boundPort();

  const ws = new WebSocket(`wss://127.0.0.1:${port}`, { rejectUnauthorized: false });
  await once(ws, "open");

  const infoPromise = nextMessage(ws, "agentInfo");
  ws.send(encodeMessage({ type: "auth", secret: "s3cret" }));
  await infoPromise;

  assert.equal(captureStopCalls.count, 0);

  const offerPromise = nextMessage(ws, "webrtcOffer");
  ws.send(encodeMessage({ type: "startWebrtc" }));
  const offerMsg = await offerPromise;
  assert.equal(offerMsg.type, "webrtcOffer");
  if (offerMsg.type === "webrtcOffer") {
    assert.ok(offerMsg.sdp.startsWith("v=0"));
  }
  // handleStartWebrtc calls this.deps.capture.stop() to enforce mode
  // exclusivity before creating the offer.
  assert.equal(captureStopCalls.count, 1);

  const statePromise = nextMessage(ws, "webrtcState");
  ws.send(encodeMessage({ type: "stopWebrtc" }));
  const stateMsg = await statePromise;
  assert.equal(stateMsg.type, "webrtcState");
  if (stateMsg.type === "webrtcState") {
    assert.equal(stateMsg.active, false);
  }

  ws.close();
  await server.close();
});

test("setAudio while WebRTC is active is rejected with agentError, not audioState", async () => {
  const server = await startServer("s3cret", []);
  const port = server.boundPort();

  const ws = new WebSocket(`wss://127.0.0.1:${port}`, { rejectUnauthorized: false });
  await once(ws, "open");

  const infoPromise = nextMessage(ws, "agentInfo");
  ws.send(encodeMessage({ type: "auth", secret: "s3cret" }));
  await infoPromise;

  const offerPromise = nextMessage(ws, "webrtcOffer");
  ws.send(encodeMessage({ type: "startWebrtc" }));
  await offerPromise;

  const errorPromise = nextMessage(ws, "agentError");
  ws.send(encodeMessage({ type: "setAudio", enabled: true }));
  const errorMsg = await errorPromise;
  assert.equal(errorMsg.type, "agentError");
  if (errorMsg.type === "agentError") {
    assert.match(errorMsg.message, /Classic audio is paused while WebRTC is active/);
  }

  // Prove no audioState (enabled:true) ever arrived for this request: race a
  // short timer against a listener for that specific message.
  let sawEnabledAudioState = false;
  const onMsg = (data: WebSocket.RawData, isBinary: boolean) => {
    if (isBinary) return;
    const parsed = parseAgentMessage(data.toString());
    if (parsed.type === "audioState" && parsed.enabled) sawEnabledAudioState = true;
  };
  ws.on("message", onMsg);
  await new Promise((r) => setTimeout(r, 50));
  ws.off("message", onMsg);
  assert.equal(sawEnabledAudioState, false);

  ws.close();
  await server.close();
});

test("disconnecting during an active WebRTC session tears it down so a fresh connection can start clean", async () => {
  const captureStopCalls = { count: 0 };
  const server = await startServer("s3cret", [], { captureStopCalls });
  const port = server.boundPort();

  const ws1 = new WebSocket(`wss://127.0.0.1:${port}`, { rejectUnauthorized: false });
  await once(ws1, "open");
  const info1 = nextMessage(ws1, "agentInfo");
  ws1.send(encodeMessage({ type: "auth", secret: "s3cret" }));
  await info1;

  const offer1 = nextMessage(ws1, "webrtcOffer");
  ws1.send(encodeMessage({ type: "startWebrtc" }));
  await offer1;

  // Disconnect without an explicit stopWebrtc; the server's ws "close" handler
  // must tear the session down (this.webrtc = null) so it doesn't linger.
  ws1.close();
  await new Promise((r) => setTimeout(r, 100));

  // A fresh connection should be able to immediately start a new WebRTC
  // session without hitting a stale-session issue (e.g. handleStartWebrtc's
  // `if (this.webrtc) return` no-op guard).
  const ws2 = new WebSocket(`wss://127.0.0.1:${port}`, { rejectUnauthorized: false });
  await once(ws2, "open");
  const info2 = nextMessage(ws2, "agentInfo");
  ws2.send(encodeMessage({ type: "auth", secret: "s3cret" }));
  await info2;

  const offer2 = nextMessage(ws2, "webrtcOffer");
  ws2.send(encodeMessage({ type: "startWebrtc" }));
  const offerMsg2 = await offer2;
  assert.equal(offerMsg2.type, "webrtcOffer");

  ws2.close();
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
