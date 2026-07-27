import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { platform } from "node:os";
import { buildVideoFilter } from "./videoFilter.js";
import { VIDEO_CODEC_TIERS, VIDEO_CODEC_BASELINE, VIDEO_CODEC_VP8 } from "./codecs.js";
import { ffmpegAvailable } from "../capture/ffmpeg.js";

test("caps fps for every tier", () => {
  for (const tier of VIDEO_CODEC_TIERS) {
    assert.match(buildVideoFilter(tier), new RegExp(`^fps=${tier.maxFps},`));
  }
});

test("each tier clamps to its own width cap", () => {
  assert.match(buildVideoFilter(VIDEO_CODEC_BASELINE), /min\(1280,iw\)/);
  assert.match(buildVideoFilter(VIDEO_CODEC_VP8), /min\(1280,iw\)/);
});

test("a levelled tier bounds frame area by its macroblock budget", () => {
  // P = maxMacroblocks * 256; see buildVideoFilter's derivation.
  assert.match(buildVideoFilter(VIDEO_CODEC_BASELINE), new RegExp(String(3600 * 256)));
});

/**
 * VP8 has no levels, so there is no area constraint to encode into the filter —
 * only the width cap applies. Emitting the quadratic anyway would shrink the
 * picture for no reason.
 */
test("a level-free tier (VP8) applies no area bound", () => {
  const chain = buildVideoFilter(VIDEO_CODEC_VP8);
  assert.doesNotMatch(chain, /sqrt/);
  assert.match(chain, /scale=w='trunc\(min\(1280,iw\)\/2\)\*2':h=-2/);
});

test("an uncapped, level-free tier neither scales down nor bounds area", () => {
  const chain = buildVideoFilter({ ...VIDEO_CODEC_VP8, maxWidth: null });
  assert.doesNotMatch(chain, /sqrt/);
  assert.doesNotMatch(chain, /min\(\d+,iw\)/);
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
    for (const tier of VIDEO_CODEC_TIERS) {
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
  for (const tier of VIDEO_CODEC_TIERS) {
    assert.doesNotMatch(buildVideoFilter(tier), /hwdownload/);
  }
});

/** Runs a tier's real encoder over a synthetic source and returns ffmpeg's output. */
function encode(tier: (typeof VIDEO_CODEC_TIERS)[number], size: string, frames: number) {
  const res = spawnSync(
    "ffmpeg",
    [
      "-hide_banner", "-loglevel", "warning",
      "-f", "lavfi", "-i", `testsrc=size=${size}:rate=${tier.maxFps}`,
      "-frames:v", String(frames),
      "-pix_fmt", "yuv420p",
      "-vf", buildVideoFilter(tier),
      ...tier.encoderArgs,
      "-b:v", `${tier.maxBitrateKbps}k`,
      // Encode to nowhere: we only care that the encoder opens and produces
      // packets, not about the bytes.
      "-f", "null", "-",
    ],
    { encoding: "utf8" },
  );
  return { status: res.status, output: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

/**
 * The real invariant, exercised against real ffmpeg rather than asserted on
 * the filter string: libx264 + yuv420p rejects odd dimensions outright
 * ("width not divisible by 2"), opens no encoder, and emits zero packets —
 * which previously surfaced as a WebRTC session that claimed to be connected
 * while streaming a permanently blank video. Odd sizes reach here for real
 * on Windows, where gdigrab captures the physical desktop and fractional DPI
 * scaling yields sizes like 1707x1067.
 */
const ODD_SIZES = ["1707x1067", "1001x667"];

for (const tier of VIDEO_CODEC_TIERS) {
  for (const size of ODD_SIZES) {
    test(`${tier.label} encodes odd ${size} input`, (t) => {
      if (!ffmpegAvailable()) {
        t.skip("ffmpeg not on PATH");
        return;
      }
      const { status, output } = encode(tier, size, 10);
      assert.equal(status, 0, `ffmpeg failed for ${size}:\n${output}`);
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
 * desktop it produced 1280x832 = 4160 macroblocks and libx264 said:
 *
 *   frame MB size (80x52) > level limit (3600)
 *   MB rate (124800) > level limit (108000)
 *
 * x264 warns but still writes the requested level into the SPS, so the browser
 * negotiated level 3.1, received a stream that violated it, and rejected every
 * frame — a blank <video> and endless keyframe requests.
 *
 * Sizes deliberately span 16:9, 16:10, 4:3, the ~1.55:1 Retina shape that
 * actually broke, a DPI-scaled odd size, 5K, and portrait. Run for every tier,
 * including level-free ones, so a tier that later gains a level is covered
 * automatically.
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

for (const tier of VIDEO_CODEC_TIERS) {
  for (const size of ASPECT_RATIOS) {
    test(`${tier.label} stays within its level for ${size}`, (t) => {
      if (!ffmpegAvailable()) {
        t.skip("ffmpeg not on PATH");
        return;
      }
      const { status, output } = encode(tier, size, 3);
      assert.equal(status, 0, `ffmpeg failed for ${size}:\n${output}`);
      assert.doesNotMatch(
        output,
        /level limit/i,
        `encode exceeded this tier's level for a ${size} source — the browser ` +
          `negotiates that level and will reject a stream that breaks it`,
      );
    });
  }
}
