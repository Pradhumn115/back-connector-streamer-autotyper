// Non-intrusive end-to-end check: connects to a locally-running agent, performs
// the real auth handshake, and captures ONE real screenshot frame through the
// full WSS pipeline. Does NOT move the mouse or type anything.
//
// Usage: node scripts/verify-e2e.mjs <secret> [port]
import WebSocket from "ws";
import { writeFileSync } from "node:fs";
import { decodeFrame, encodeMessage, isFrame, parseAgentMessage } from "@bcsa/shared";

const secret = process.argv[2];
const port = process.argv[3] || "8443";
if (!secret) {
  console.error("Usage: node scripts/verify-e2e.mjs <secret> [port]");
  process.exit(1);
}

const ws = new WebSocket(`wss://127.0.0.1:${port}`, { rejectUnauthorized: false });
let gotInfo = false;
const timeout = setTimeout(() => {
  console.error("❌ Timed out waiting for a frame (is the agent running? screen-recording permission granted?)");
  process.exit(1);
}, 15000);

ws.on("open", () => {
  console.log("① TCP+TLS connected to agent");
  ws.send(encodeMessage({ type: "auth", secret }));
});

ws.on("message", (data, isBinary) => {
  if (!isBinary) {
    const msg = parseAgentMessage(data.toString());
    if (msg.type === "authResult") {
      console.log(msg.ok ? "② Auth OK" : `❌ Auth failed: ${msg.reason}`);
      if (!msg.ok) process.exit(1);
    } else if (msg.type === "agentInfo") {
      gotInfo = true;
      console.log(`③ agentInfo: ${msg.nickname} @ ${msg.screenWidth}x${msg.screenHeight}`);
    } else if (msg.type === "agentError") {
      console.log(`⚠️  agentError: ${msg.message}`);
    }
    return;
  }
  const bytes = new Uint8Array(data);
  if (!isFrame(bytes)) return;
  const frame = decodeFrame(bytes);
  clearTimeout(timeout);
  const outPath = "/tmp/bcsa-verify-frame.jpg";
  writeFileSync(outPath, frame.payload);
  console.log(`④ Received real screen frame: seq=${frame.seq}, ${frame.payload.byteLength} bytes -> ${outPath}`);
  console.log("✅ End-to-end pipeline works: capture → encode → WSS → decode.");
  ws.close();
  process.exit(0);
});

ws.on("error", (err) => {
  console.error(`❌ WS error: ${err.message}`);
  process.exit(1);
});
