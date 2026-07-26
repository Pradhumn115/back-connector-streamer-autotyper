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

  // A syntactically valid answer SDP with a bogus ICE ufrag/pwd and
  // candidates rewritten to an unroutable address (TEST-NET-2, RFC 5737):
  // setRemoteDescription() accepts it, ICE has *something* to try, but it
  // can never actually reach that address, so awaitConnected() genuinely
  // hits the timeout branch rather than short-circuiting through the
  // immediate "failed"/"closed" path (which is what stripping all
  // a=candidate lines entirely was found to do instead).
  const bogusAnswer = offerSdp
    .replace(/a=setup:actpass/g, "a=setup:active")
    .replace(/o=- (\d+)/, "o=- $1")
    .replace(/a=ice-ufrag:\S+/g, "a=ice-ufrag:deadbeef")
    .replace(/a=ice-pwd:\S+/g, "a=ice-pwd:deadbeefdeadbeefdeadbeef")
    .replace(/(a=candidate:\S+ \d+ udp \d+ )\S+/g, "$1198.51.100.9")
    .replace(/a=sendonly/g, "a=recvonly");

  await assert.rejects(
    () => session.setAnswer(bogusAnswer),
    /ICE did not connect within/,
    "expected the timeout branch, not the failed/closed path",
  );

  assert.equal(states.length, 1);
  assert.equal(states[0]?.active, false);
  assert.ok(states[0]?.error, "expected an error message on the failure state");
  assert.match(
    states[0]?.error ?? "",
    /ICE did not connect within/,
    "reported error should come from the timeout branch",
  );

  // A subsequent close() must not fire onStateChange again — the failure
  // latch set by the timeout should still be in effect since setAnswer()
  // never succeeded.
  session.close();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(states.length, 1);
});
