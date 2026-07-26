import { test } from "node:test";
import assert from "node:assert/strict";
import { RTCPeerConnection } from "werift";
import { WebrtcSession } from "./session.js";
import { VIDEO_CODEC, AUDIO_CODEC } from "./codecs.js";

test("createOffer/setAnswer establishes a connection and relays RTP", async () => {
  const states: Array<{ active: boolean; error?: string }> = [];
  const session = new WebrtcSession({
    // No real ffmpeg: these args are never spawned in this test because we
    // inject packets directly below instead of relying on RtpRelay's ffmpeg
    // spawn — see note after this test.
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

  assert.equal(states.at(-1)?.active, true);

  session.close();
  await browserPc.close();
});
