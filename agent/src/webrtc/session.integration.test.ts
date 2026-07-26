import { test } from "node:test";
import assert from "node:assert/strict";
import { RTCPeerConnection } from "werift";
import { WebrtcSession } from "./session.js";
import { VIDEO_CODEC, AUDIO_CODEC } from "./codecs.js";

test("createOffer/setAnswer establishes a connection and relays RTP", async () => {
  const states: Array<{ active: boolean; error?: string }> = [];
  const session = new WebrtcSession({
    // RtpRelay.start() really does spawn ffmpeg with these args; if ffmpeg
    // isn't installed in the test environment the spawn fails and RtpRelay
    // catches/logs that failure internally, so the test still passes
    // without ffmpeg on PATH. These args are otherwise inert: nullsrc/
    // anullsrc + `-f null -` never actually emit RTP.
    videoFfmpegArgs: () => ["-f", "lavfi", "-i", "nullsrc", "-f", "null", "-"],
    audioFfmpegArgs: () => ["-f", "lavfi", "-i", "anullsrc", "-f", "null", "-"],
    onStateChange: (active, error) => states.push({ active, error }),
  });

  const offerSdp = await session.createOffer();

  // Stand-in "browser" peer: recvonly, using the same codecs the agent offers.
  const browserPc = new RTCPeerConnection({
    codecs: { video: [VIDEO_CODEC], audio: [AUDIO_CODEC] },
  });
  await browserPc.setRemoteDescription({ type: "offer", sdp: offerSdp });
  const answer = await browserPc.createAnswer();
  await browserPc.setLocalDescription(answer);

  await session.setAnswer(browserPc.localDescription!.sdp);

  // Exactly one state change: a spurious pre-connect failure (e.g. a
  // transient "disconnected" blip racing the initial connect) would also
  // leave states.at(-1) === true if a later real connect fired, silently
  // hiding the extra callback. Asserting the count catches that.
  assert.equal(states.length, 1);
  assert.equal(states.at(-1)?.active, true);

  session.close();
  await browserPc.close();
});

test("setAnswer rejects on ICE-connect timeout and reports failure exactly once", async () => {
  const states: Array<{ active: boolean; error?: string }> = [];
  const session = new WebrtcSession({
    videoFfmpegArgs: () => ["-f", "lavfi", "-i", "nullsrc", "-f", "null", "-"],
    audioFfmpegArgs: () => ["-f", "lavfi", "-i", "anullsrc", "-f", "null", "-"],
    onStateChange: (active, error) => states.push({ active, error }),
    // Short-circuit the 5s production timeout so this test doesn't have to
    // wait for it.
    iceConnectTimeoutMs: 200,
  });

  const offerSdp = await session.createOffer();

  // A syntactically valid answer SDP with a bogus ICE ufrag/pwd and no
  // reachable candidates: setRemoteDescription() accepts it, but ICE can
  // never actually establish a connection against it, so awaitConnected()
  // is guaranteed to hit the timeout branch rather than "connected".
  const bogusAnswer = offerSdp
    .replace(/a=setup:actpass/g, "a=setup:active")
    .replace(/o=- (\d+)/, "o=- $1")
    .replace(/a=ice-ufrag:\S+/g, "a=ice-ufrag:deadbeef")
    .replace(/a=ice-pwd:\S+/g, "a=ice-pwd:deadbeefdeadbeefdeadbeef")
    .replace(/a=candidate:.*\r?\n/g, "")
    .replace(/a=sendonly/g, "a=recvonly");

  await assert.rejects(() => session.setAnswer(bogusAnswer));

  assert.equal(states.length, 1);
  assert.equal(states[0]?.active, false);
  assert.ok(states[0]?.error, "expected an error message on the failure state");

  // A subsequent close() must not fire onStateChange again — the failure
  // latch set by the timeout should still be in effect since setAnswer()
  // never succeeded.
  session.close();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(states.length, 1);
});
