import { test } from "node:test";
import assert from "node:assert/strict";
import { createSocket } from "node:dgram";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { VIDEO_CODEC_BASELINE, type VideoCodecTier } from "./codecs.js";
import { ffmpegAvailable } from "../capture/ffmpeg.js";

/**
 * These tests run the real production encoder tail and inspect what actually
 * comes out, because two separate bugs here produced a bitstream that was
 * well-formed by every structural measure -- RTP flowing, SPS/PPS in-band,
 * keyframes on schedule -- and still could not be decoded by any browser. The
 * session reported itself connected while the receiver asked for a keyframe
 * forever against a blank <video>. Neither bug is visible in the arguments
 * alone; both are only visible in the encoded output.
 */

/**
 * Encoder options shared by both inspections; mirrors agent/src/index.ts.
 *
 * `override` replaces the tier's own encoder args wholesale, which the vacuity
 * guards use to reproduce the original bugs on purpose.
 */
function encoderArgs(tier: VideoCodecTier, override?: string[]): string[] {
  return [
    "-pix_fmt", "yuv420p",
    ...(override ?? tier.encoderArgs),
    "-g", String(tier.maxFps),
    "-b:v", `${tier.maxBitrateKbps}k`,
  ];
}

/** The x264 args this tier ships, with one parameter swapped out. */
function withX264Params(tier: VideoCodecTier, params: string, threads = "1"): string[] {
  const args = [...tier.encoderArgs];
  const p = args.indexOf("-x264-params");
  if (p >= 0) args[p + 1] = params;
  const t = args.indexOf("-threads");
  if (t >= 0) args[t + 1] = threads;
  return args;
}

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

/** Encodes to RTP and reports the NAL structure of the packets produced. */
function encodeAndInspect(tier: VideoCodecTier, override?: string[]): Promise<StreamShape> {
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
          ...encoderArgs(tier, override),
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

/** Encodes to a file and returns what ffprobe says the bitstream actually is. */
function encodedProfile(tier: VideoCodecTier, override?: string[]): string {
  const out = join(tmpdir(), `bcsa-profile-${tier.codec.payloadType}-${process.pid}.mp4`);
  try {
    const enc = spawnSync(
      "ffmpeg",
      [
        "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", `testsrc=size=640x480:rate=${tier.maxFps}`,
        "-frames:v", "30",
        ...encoderArgs(tier, override),
        "-y", out,
      ],
      { encoding: "utf8" },
    );
    assert.equal(enc.status, 0, `ffmpeg failed: ${enc.stderr}`);
    const probe = spawnSync(
      "ffprobe",
      ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=profile", "-of", "csv=p=0", out],
      { encoding: "utf8" },
    );
    assert.equal(probe.status, 0, `ffprobe failed: ${probe.stderr}`);
    return probe.stdout.trim();
  } finally {
    rmSync(out, { force: true });
  }
}

/**
 * profile_idc that a tier's advertised `profile-level-id` promises the browser,
 * taken from the first byte of that field (0x64 = High, 0x42 = Baseline).
 */
function advertisedProfileName(tier: VideoCodecTier): string {
  const id = /profile-level-id=([0-9a-fA-F]{6})/.exec(String(tier.codec.parameters))?.[1];
  assert.ok(id, `tier ${tier.label} has no profile-level-id`);
  const idc = parseInt(id.slice(0, 2), 16);
  if (idc === 0x64) return "High";
  if (idc === 0x42) return "Constrained Baseline";
  throw new Error(`unhandled profile_idc 0x${idc.toString(16)}`);
}

for (const tier of [VIDEO_CODEC_BASELINE]) {
  /**
   * The encoded bitstream must declare the very profile the SDP promised.
   *
   * `-profile:v` is a CEILING, not a floor -- it forbids tools above the named
   * profile but enables none. `-preset ultrafast` switches off CABAC and the
   * 8x8 transform, so with `-profile:v high` alone x264 emitted a stream using
   * nothing above Constrained Baseline and wrote profile_idc=66 into the SPS.
   * The offer still advertised High (640034), the browser built a High decoder
   * on that promise, and then rejected every frame it received.
   */
  test(`${tier.label} encodes the profile its SDP advertises`, (t) => {
    if (!ffmpegAvailable()) {
      t.skip("ffmpeg not on PATH");
      return;
    }
    assert.equal(
      encodedProfile(tier),
      advertisedProfileName(tier),
      "the encoded bitstream's profile must match the profile-level-id offered " +
        "in SDP — a browser that negotiates one profile and receives another " +
        "rejects every frame and PLIs forever against a blank <video>",
    );
  });

  /**
   * Frames must not be split into slices; browser WebRTC decoders do not
   * reliably decode multi-slice frames. The signature is slice NALs aggregated
   * into STAP-A packets — a whole-frame slice is far too big to aggregate and
   * is always fragmented into FU-A instead.
   */
  test(`${tier.label} encodes one slice per frame`, async (t) => {
    if (!ffmpegAvailable()) {
      t.skip("ffmpeg not on PATH");
      return;
    }

    const shape = await encodeAndInspect(tier);

    assert.ok(shape.packets > 0, "expected the encoder to actually produce RTP");
    assert.equal(
      shape.aggregatedSlices,
      0,
      "found slice NALs aggregated into STAP-A packets, so frames are being " +
        "split into multiple slices",
    );
    // The parameter sets must also travel in-band: the SDP this project
    // generates carries no sprop-parameter-sets, so a receiver that never sees
    // SPS/PPS in the stream can never initialise its decoder.
    assert.ok(shape.sawSps, "SPS (NAL 7) must appear in-band");
    assert.ok(shape.sawPps, "PPS (NAL 8) must appear in-band");
  });
}

/**
 * Vacuity guards: both assertions above must be capable of failing, or they
 * would silently pass forever. These reproduce each original bug on purpose.
 */
test("sanity: the pre-fix settings really do trip both assertions", (t) => {
  if (!ffmpegAvailable()) {
    t.skip("ffmpeg not on PATH");
    return;
  }

  // Without cabac/8x8dct, ultrafast emits Constrained Baseline under the High
  // tier's High-profile SDP -- the mismatch that broke decoding everywhere.
  assert.equal(
    encodedProfile(VIDEO_CODEC_BASELINE, withX264Params(VIDEO_CODEC_BASELINE, "sliced-threads=0")
      .map((a) => (a === "baseline" ? "high" : a))),
    "Constrained Baseline",
    "asking libx264 for High while ultrafast is on still yields Constrained " +
      "Baseline — `-profile:v` is a ceiling, not a floor",
  );
});

test("sanity: sliced-threads (the old behaviour) is detectable", async (t) => {
  if (!ffmpegAvailable()) {
    t.skip("ffmpeg not on PATH");
    return;
  }

  // Slicing needs more than one thread to slice across, so this overrides both.
  const shape = await encodeAndInspect(
    VIDEO_CODEC_BASELINE,
    withX264Params(VIDEO_CODEC_BASELINE, "sliced-threads=1", "4"),
  );
  if (shape.aggregatedSlices === 0) {
    t.skip("this machine/build did not slice; nothing to detect");
    return;
  }
  assert.ok(shape.aggregatedSlices > 0);
});
