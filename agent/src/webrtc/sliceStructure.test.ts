import { test } from "node:test";
import assert from "node:assert/strict";
import { createSocket } from "node:dgram";
import { spawn } from "node:child_process";
import { VIDEO_CODEC_HIGH, VIDEO_CODEC_BASELINE, type VideoCodecTier } from "./codecs.js";
import { ffmpegAvailable } from "../capture/ffmpeg.js";

/**
 * Guards the encoder setting that actually made browsers decode.
 *
 * `-tune zerolatency` enables x264's sliced-threads, cutting every frame into
 * one slice per worker thread. The resulting stream is perfectly well-formed --
 * RTP flows, SPS/PPS sit in-band ahead of every IDR -- and browser WebRTC
 * decoders still fail to build a picture from it, so the receiver sends
 * keyframe requests forever against a permanently blank <video>. Because the
 * slice count tracks the CPU's core count, it reproduced on every machine at
 * once and read as a transport bug rather than an encoder flag.
 *
 * The observable signature is slice NALs aggregated into STAP-A packets: with
 * slicing on, a 90-frame clip yields several hundred of them; with one slice
 * per frame there are none, because a whole-frame slice is far too large to
 * aggregate and is always fragmented into FU-A instead.
 *
 * This asserts against the real RTP output of the production argument tail, so
 * it fails if `-threads`/`sliced-threads` are dropped, or if a future preset or
 * tune change reintroduces slicing.
 */

/** NAL types carried inside a STAP-A aggregation packet. */
function stapNalTypes(payload: Buffer): number[] {
  const types: number[] = [];
  let i = 1; // past the STAP-A header byte
  while (i + 2 <= payload.length) {
    const size = payload.readUInt16BE(i);
    i += 2;
    if (size === 0 || i + size > payload.length) break;
    types.push(payload[i] & 0x1f);
    i += size;
  }
  return types;
}

interface StreamShape {
  /** Slice NALs (types 1/5) found inside STAP-A packets — the slicing tell. */
  aggregatedSlices: number;
  sawSps: boolean;
  sawPps: boolean;
  packets: number;
}

/**
 * Encodes a short synthetic clip with the production encoder tail and reports
 * the NAL structure of the RTP it produces.
 */
function encodeAndInspect(tier: VideoCodecTier, extra: string[]): Promise<StreamShape> {
  return new Promise((resolve, reject) => {
    const socket = createSocket("udp4");
    const shape: StreamShape = { aggregatedSlices: 0, sawSps: false, sawPps: false, packets: 0 };

    socket.on("message", (msg) => {
      if (msg.length < 13) return;
      shape.packets++;
      const offset = 12 + (msg[0] & 0x0f) * 4; // fixed header + CSRC list
      const type = msg[offset] & 0x1f;
      if (type === 24) {
        for (const inner of stapNalTypes(msg.subarray(offset))) {
          if (inner === 1 || inner === 5) shape.aggregatedSlices++;
          if (inner === 7) shape.sawSps = true;
          if (inner === 8) shape.sawPps = true;
        }
      } else if (type === 7) shape.sawSps = true;
      else if (type === 8) shape.sawPps = true;
    });

    socket.bind(0, "127.0.0.1", () => {
      const port = (socket.address() as { port: number }).port;
      const proc = spawn(
        "ffmpeg",
        [
          "-hide_banner", "-loglevel", "error",
          "-f", "lavfi", "-i", `testsrc=size=640x480:rate=${tier.maxFps}`,
          "-frames:v", "90",
          "-pix_fmt", "yuv420p",
          "-c:v", "libx264",
          "-profile:v", tier.ffmpegProfile,
          "-level", tier.ffmpegLevel,
          "-preset", "ultrafast",
          "-tune", "zerolatency",
          ...extra,
          "-g", String(tier.maxFps),
          "-b:v", `${tier.maxBitrateKbps}k`,
          "-pkt_size", "1200",
          "-f", "rtp", `rtp://127.0.0.1:${port}`,
        ],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      let stderr = "";
      proc.stderr.setEncoding("utf8");
      proc.stderr.on("data", (c: string) => { stderr += c; });
      proc.on("error", reject);
      proc.on("exit", (code) => {
        // Let the last datagrams land before tearing the socket down.
        setTimeout(() => {
          socket.close();
          if (code !== 0) reject(new Error(`ffmpeg exited ${code}: ${stderr}`));
          else resolve(shape);
        }, 300);
      });
    });
  });
}

for (const tier of [VIDEO_CODEC_HIGH, VIDEO_CODEC_BASELINE]) {
  test(`${tier.ffmpegProfile}/${tier.ffmpegLevel} encodes one slice per frame`, async (t) => {
    if (!ffmpegAvailable()) {
      t.skip("ffmpeg not on PATH");
      return;
    }

    const shape = await encodeAndInspect(tier, ["-threads", "1", "-x264-params", "sliced-threads=0"]);

    assert.ok(shape.packets > 0, "expected the encoder to actually produce RTP");
    assert.equal(
      shape.aggregatedSlices,
      0,
      "found slice NALs aggregated into STAP-A packets, which means frames are " +
        "being split into multiple slices — browser WebRTC decoders do not " +
        "reliably decode that, and the receiver will PLI forever against a " +
        "blank <video>",
    );
    // The parameter sets must also travel in-band: the SDP this project
    // generates carries no sprop-parameter-sets, so a receiver that never sees
    // SPS/PPS in the stream can never initialise its decoder.
    assert.ok(shape.sawSps, "SPS (NAL 7) must appear in-band");
    assert.ok(shape.sawPps, "PPS (NAL 8) must appear in-band");
  });
}

/**
 * Vacuity guard: proves the assertion above can actually fail. Without the
 * thread flags, `-tune zerolatency` slices and the aggregated-slice count is
 * firmly non-zero, so the test is measuring the real thing.
 */
test("sanity: sliced-threads (the old behaviour) is detectable", async (t) => {
  if (!ffmpegAvailable()) {
    t.skip("ffmpeg not on PATH");
    return;
  }

  const shape = await encodeAndInspect(VIDEO_CODEC_HIGH, []);
  if (shape.aggregatedSlices === 0) {
    // A single-core machine has nothing to slice across, so zerolatency
    // produces one slice per frame anyway and there is nothing to detect.
    t.skip("this machine does not slice (likely a single-core runner)");
    return;
  }
  assert.ok(
    shape.aggregatedSlices > 0,
    "expected the un-fixed argument set to produce multi-slice frames",
  );
});
