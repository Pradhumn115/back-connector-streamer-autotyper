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

function fakeCapture(): CaptureLoop {
  const image: CapturedImage = { data: new Uint8Array([1, 2, 3, 4]), format: FrameFormat.JPEG };
  return new CaptureLoop(async () => image, 30);
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

async function startServer(secret: string, recorded: string[]) {
  const server = new ConnectionServer({
    secret,
    nickname: "test-agent",
    port: 0,
    host: "127.0.0.1",
    tls: ephemeralTls(),
    input: fakeInput(recorded),
    capture: fakeCapture(),
    typingBackend: fakeTyping(),
    inputLock: fakeInputLock(),
    audio: new AudioCapture(null), // no loopback device -> supported:false, no ffmpeg
    refreshHz: 60,
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
