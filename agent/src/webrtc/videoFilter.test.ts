import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { platform } from "node:os";
import { buildVideoFilter } from "./videoFilter.js";
import { VIDEO_CODEC_HIGH, VIDEO_CODEC_BASELINE } from "./codecs.js";
import { ffmpegAvailable } from "../capture/ffmpeg.js";

test("caps fps for both tiers", () => {
  assert.match(buildVideoFilter(VIDEO_CODEC_HIGH), /^fps=60,/);
  assert.match(buildVideoFilter(VIDEO_CODEC_BASELINE), /^fps=30,/);
});

test("each tier clamps to its own width cap", () => {
  assert.match(buildVideoFilter(VIDEO_CODEC_BASELINE), /min\(1280,iw\)/);
  // The high tier was uncapped until encoding a Retina desktop at native size
  // (3456x2234 @60) measured speed=0.991x against the real screen device --
  // keeping up with nothing to spare. See VIDEO_CODEC_HIGH.maxWidth.
  assert.match(buildVideoFilter(VIDEO_CODEC_HIGH), /min\(1920,iw\)/);
});

test("both tiers bound frame area by their level's macroblock budget", () => {
  // P = maxMacroblocks * 256; see buildVideoFilter's derivation.
  assert.match(buildVideoFilter(VIDEO_CODEC_BASELINE), new RegExp(String(3600 * 256)));
  assert.match(buildVideoFilter(VIDEO_CODEC_HIGH), new RegExp(String(34560 * 256)));
});

test("an uncapped tier is still bounded by the macroblock budget", () => {
  const chain = buildVideoFilter({ ...VIDEO_CODEC_HIGH, maxWidth: null });
  assert.doesNotMatch(chain, /min\(\d+,iw\)/);
  assert.match(chain, new RegExp(String(34560 * 256)));
});

/**
 * ddagrab emits D3D11 hardware frames, so every CPU-side filter must be
 * preceded by hwdownload — and it must come FIRST in the chain, before
 * fps/crop/scale, or ffmpeg fails format negotiation. This only applies on
 * Windows with the backend opted into, so the platform check mirrors
 * captureFilterPrefix()'s own.
 */
test("ddagrab opt-in prefixes the chain with hwdownload, ahead of the CPU filters", (t) => {
  if (platform() !== "win32") {
    t.skip("captureFilterPrefix() is a no-op off Windows");
    return;
  }
  const prev = process.env.BCSA_WIN_CAPTURE;
  process.env.BCSA_WIN_CAPTURE = "ddagrab";
  try {
    for (const tier of [VIDEO_CODEC_HIGH, VIDEO_CODEC_BASELINE]) {
      const chain = buildVideoFilter(tier);
      assert.ok(
        chain.startsWith("hwdownload,format=bgra,"),
        `hwdownload must lead the chain, got: ${chain}`,
      );
      assert.ok(chain.indexOf("hwdownload") < chain.indexOf("fps="), "hwdownload before fps");
    }
  } finally {
    if (prev === undefined) delete process.env.BCSA_WIN_CAPTURE;
    else process.env.BCSA_WIN_CAPTURE = prev;
  }
});

test("gdigrab (default) adds no hwdownload prefix", () => {
  assert.doesNotMatch(buildVideoFilter(VIDEO_CODEC_HIGH), /hwdownload/);
  assert.doesNotMatch(buildVideoFilter(VIDEO_CODEC_BASELINE), /hwdownload/);
});

/**
 * The real invariant, exercised against real ffmpeg rather than asserted on
 * the filter string: libx264 + yuv420p rejects odd dimensions outright
 * ("width not divisible by 2"), opens no encoder, and emits zero packets —
 * which previously surfaced as a WebRTC session that claimed to be connected
 * while streaming a permanently blank video. Odd sizes reach here for real
 * on Windows, where gdigrab captures the physical desktop and fractional DPI
 * scaling yields sizes like 1707x1067.
 *
 * Both an odd size *above* the baseline tier's 1280 cap and one *below* it
 * are covered: capping via `min(1280, iw)` alone silently passes an odd `iw`
 * straight through whenever it's already under the cap, so the sub-cap case
 * is the one that actually regressed.
 */
const ODD_SIZES = ["1707x1067", "1001x667"];

for (const tier of [VIDEO_CODEC_HIGH, VIDEO_CODEC_BASELINE]) {
  for (const size of ODD_SIZES) {
    test(`${tier.ffmpegProfile}/${tier.ffmpegLevel} encodes odd ${size} input`, (t) => {
      if (!ffmpegAvailable()) {
        t.skip("ffmpeg not on PATH");
        return;
      }
      const res = spawnSync(
        "ffmpeg",
        [
          "-hide_banner", "-loglevel", "error",
          "-f", "lavfi", "-i", `testsrc=size=${size}:rate=10:duration=1`,
          "-pix_fmt", "yuv420p",
          "-vf", buildVideoFilter(tier),
          "-c:v", "libx264",
          "-profile:v", tier.ffmpegProfile,
          "-level", tier.ffmpegLevel,
          "-preset", "ultrafast",
          "-tune", "zerolatency",
          // Encode to nowhere: we only care that libx264 opens and produces
          // packets, not about the bytes.
          "-f", "null", "-",
        ],
        { encoding: "utf8" },
      );
      const output = `${res.stdout ?? ""}${res.stderr ?? ""}`;
      assert.equal(res.status, 0, `ffmpeg failed for ${size}:\n${output}`);
      assert.doesNotMatch(output, /not divisible by 2/i);
      assert.doesNotMatch(output, /Could not open encoder/i);
    });
  }
}

/**
 * Level conformance across aspect ratios — the invariant a width cap could not
 * hold.
 *
 * An H.264 level bounds frame AREA in macroblocks, not width. `maxWidth: 1280`
 * matched level 3.1's 3600-macroblock budget only at 16:9; on a 3456x2234
 * Retina desktop it produced 1280x832 = 4160 macroblocks and libx264 said:
 *
 *   frame MB size (80x52) > level limit (3600)
 *   MB rate (124800) > level limit (108000)
 *
 * x264 warns but still writes the requested level into the SPS, so the browser
 * negotiated level 3.1, received a stream that violated it, and rejected every
 * frame — a blank <video> and endless keyframe requests, exactly as with a
 * profile mismatch.
 *
 * These sizes deliberately span 16:9, 16:10, 4:3, the ~1.55:1 Retina shape
 * that actually broke, a DPI-scaled odd size, and portrait.
 */
const ASPECT_RATIOS = [
  "3456x2234", // the Retina desktop this bug was found on
  "1920x1080", // 16:9 — the only ratio the old width cap got right
  "2560x1600", // 16:10
  "1024x768",  // 4:3
  "1707x1067", // fractional DPI scaling
  "5120x2880", // 5K
  "800x1280",  // portrait
];

for (const tier of [VIDEO_CODEC_HIGH, VIDEO_CODEC_BASELINE]) {
  for (const size of ASPECT_RATIOS) {
    test(`${tier.ffmpegProfile}/${tier.ffmpegLevel} stays within its level for ${size}`, (t) => {
      if (!ffmpegAvailable()) {
        t.skip("ffmpeg not on PATH");
        return;
      }
      const res = spawnSync(
        "ffmpeg",
        [
          "-hide_banner", "-loglevel", "warning",
          "-f", "lavfi", "-i", `testsrc=size=${size}:rate=${tier.maxFps}`,
          "-frames:v", "3",
          "-pix_fmt", "yuv420p",
          "-vf", buildVideoFilter(tier),
          "-c:v", "libx264",
          "-profile:v", tier.ffmpegProfile,
          "-level", tier.ffmpegLevel,
          "-preset", "ultrafast",
          "-tune", "zerolatency",
          "-threads", "1",
          "-x264-params", tier.x264Params,
          "-f", "null", "-",
        ],
        { encoding: "utf8" },
      );
      const output = `${res.stdout ?? ""}${res.stderr ?? ""}`;
      assert.equal(res.status, 0, `ffmpeg failed for ${size}:\n${output}`);
      assert.doesNotMatch(
        output,
        /level limit/i,
        `encode exceeded level ${tier.ffmpegLevel} for a ${size} source — the ` +
          `browser negotiates this level and will reject a stream that breaks it`,
      );
    });
  }
}
