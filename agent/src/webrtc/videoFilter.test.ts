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

test("the capped tier caps width and the uncapped tier doesn't scale at all", () => {
  assert.match(buildVideoFilter(VIDEO_CODEC_BASELINE), /scale='min\(1280,/);
  assert.doesNotMatch(buildVideoFilter(VIDEO_CODEC_HIGH), /scale=/);
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
