import { test } from "node:test";
import assert from "node:assert/strict";
import { MediaStreamTrack } from "werift";
import { RtpRelay } from "./rtpRelay.js";
import { ffmpegAvailable } from "../capture/ffmpeg.js";

/**
 * Regression test for a wedged-but-alive encoder.
 *
 * RtpRelay used to treat process exit as its only health signal, so an ffmpeg
 * that started successfully and then produced nothing was invisible: no exit,
 * no respawn, no error. That is not hypothetical -- on macOS, spawning the
 * WebRTC encoder right after Classic's capture is killed can lose the race to
 * release the avfoundation device, and ffmpeg logs "Configuration of video
 * device failed, falling back to default" and then sits there emitting no
 * frames. The session reported itself connected while the browser sent
 * keyframe requests forever against a stream that never carried a frame.
 *
 * The args below stand in for that: a real ffmpeg process that runs happily
 * and writes its output to `-f null`, so the relay's UDP socket never receives
 * a packet. A short injected watchdog timeout keeps the test fast.
 */
test("a running ffmpeg that emits no RTP is detected and respawned", async (t) => {
  if (!ffmpegAvailable()) {
    t.skip("ffmpeg not on PATH");
    return;
  }

  let spawns = 0;
  const relay = new RtpRelay(
    "video",
    () => {
      spawns++;
      // Alive and healthy from the process's point of view -- and completely
      // silent as far as the RTP socket is concerned.
      return ["-hide_banner", "-loglevel", "quiet", "-f", "lavfi", "-i", "nullsrc", "-f", "null", "-"];
    },
    undefined,
    150,
  );
  t.after(() => relay.stop());

  await relay.start(new MediaStreamTrack({ kind: "video" }));

  // Watchdog fires at 150ms, then the first respawn backoff is 250ms, so a
  // second spawn must have happened comfortably within this window.
  await new Promise((resolve) => setTimeout(resolve, 1200));

  assert.ok(
    spawns >= 2,
    `expected the wedged encoder to be restarted, but it spawned only ${spawns} time(s)`,
  );
});

/**
 * The other half of the guard: an encoder that IS producing must be left
 * alone. Without the `sawData` check the watchdog would be an indiscriminate
 * timer, killing every healthy stream a fixed interval after it started.
 *
 * This one really does emit RTP into the relay's port, so the watchdog must
 * retire on the first packet and the process must survive well past its
 * timeout.
 */
test("a relay that receives RTP is left alone by the watchdog", async (t) => {
  if (!ffmpegAvailable()) {
    t.skip("ffmpeg not on PATH");
    return;
  }

  let spawns = 0;
  const relay = new RtpRelay(
    "video",
    (port) => {
      spawns++;
      return [
        "-hide_banner", "-loglevel", "quiet",
        // -re paces at wall-clock rate so this keeps emitting for the whole
        // test rather than racing to the end of a short clip and exiting.
        "-re", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=15",
        "-pix_fmt", "yuv420p", "-c:v", "libx264", "-profile:v", "baseline",
        "-preset", "ultrafast", "-tune", "zerolatency", "-g", "15",
        "-f", "rtp", `rtp://127.0.0.1:${port}`,
      ];
    },
    undefined,
    150,
  );
  t.after(() => relay.stop());

  await relay.start(new MediaStreamTrack({ kind: "video" }));

  // Several multiples of the 150ms watchdog. A healthy stream must not have
  // been restarted even once in that window.
  await new Promise((resolve) => setTimeout(resolve, 1500));

  assert.equal(
    spawns,
    1,
    `a producing encoder must not be restarted, but it spawned ${spawns} times`,
  );
});
