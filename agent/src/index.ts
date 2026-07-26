import { loadConfig } from "./config.js";
import { loadOrCreateTls } from "./tls.js";
import { localAddresses } from "./net.js";
import { isElevated } from "./inputlock/elevation.js";
import { CaptureLoop, createScreenshotCapture, type ScreenCapture } from "./capture/index.js";
import { FfmpegCapture, ffmpegAvailable, screenCaptureInputArgs } from "./capture/ffmpeg.js";
import { detectRefreshHz } from "./display.js";
import { InputController } from "./input/index.js";
import { createNutBackend } from "./input/nutBackend.js";
import { createNutTypingBackend } from "./autotyper/nutTyping.js";
import { ConnectionServer } from "./connection/index.js";
import { AudioCapture, detectLoopbackDevice } from "./audio/index.js";
import { InputLockManager } from "./inputlock/index.js";
import { createInputLockBackend } from "./inputlock/backends.js";
import { registerLockHotkey } from "./inputlock/hotkey.js";

// Auto-release the input lock after this long without client activity.
const INPUT_LOCK_AUTO_RELEASE_MS = 10_000;

async function main(): Promise<void> {
  const config = loadConfig();
  const tls = loadOrCreateTls();

  const input = new InputController(await createNutBackend());
  const typingBackend = await createNutTypingBackend();
  // Detect the loopback device once and share it between AudioCapture (Classic
  // audio) and the WebRTC audio args below — detectLoopbackDevice() spawns
  // ffmpeg synchronously to enumerate devices, so running it twice at startup
  // is wasted work.
  const loopback = detectLoopbackDevice();
  const audio = new AudioCapture(loopback);

  // Prefer the continuous ffmpeg pipeline (can sustain ~30fps); fall back to the
  // per-frame screenshot loop (a few fps) when ffmpeg isn't installed.
  const maxWidth = process.env.BCSA_MAX_WIDTH ? Number(process.env.BCSA_MAX_WIDTH) : 1920;
  const refreshHz = detectRefreshHz();
  let capture: ScreenCapture;
  let captureKind: string;
  if (ffmpegAvailable()) {
    capture = new FfmpegCapture({ maxWidth });
    captureKind = `ffmpeg (targets display refresh ~${refreshHz}fps, max width ${maxWidth}px)`;
  } else {
    capture = new CaptureLoop(createScreenshotCapture());
    captureKind = "screenshot-desktop (install ffmpeg for higher fps)";
  }

  // WebRTC ffmpeg args: same per-OS screen-capture input as FfmpegCapture and
  // the same loopback-device detection as AudioCapture (see capture/ffmpeg.ts
  // and audio/detect.ts) — only the output tail differs (RTP + libx264/libopus
  // instead of MJPEG-over-pipe/raw-PCM-over-pipe).
  //
  // Target the agent's real display refresh rate, same as Classic mode's
  // client-side intervalForMode()/MAX_FPS in ScreenView.tsx: clamp
  // Math.round(refreshHz) to [1, MAX_WEBRTC_FPS].
  //
  // Every earlier round of level-bumping here (3.1 -> 4.0 -> 5.1 -> 6.0)
  // was tuned against libx264's own leniency (it warns but keeps encoding
  // when nominally over a level's macroblock-rate budget) without checking
  // whether a real WebRTC decoder — Chrome — supports the declared level at
  // all. It doesn't support level 6.0 in any profile: Chrome's own
  // RTCRtpSender.getCapabilities('video') capability list tops out at
  // profile-level-id 640034 (High profile, level 5.2), so the level 6.0
  // offer was being answered with zero video codecs and
  // setRemoteDescription() failed with "negotiate codecs failed." every
  // time — a hard, deterministic negotiation failure, not the
  // hang/no-packets failure mode of the earlier too-low levels. See
  // webrtc/codecs.ts's VIDEO_CODEC comment for the full profile/level
  // arithmetic and Chrome capability query output.
  //
  // -profile:v/-level below were changed to high/5.2 to match. Level 5.2's
  // MaxMBPS (2,073,600 MB/s) is nominally ~1.75x short of the 3,628,800
  // MB/s this machine's native 3456x2234@120fps capture would need — but as
  // with the earlier over-budget levels, libx264 encodes anyway (advisory
  // warning only). MAX_WEBRTC_FPS below was set from a real-Chrome
  // empirical test of decoded output (not just packet flow) — see the
  // task11 fix report for the getStats() framesDecoded numbers that
  // determined this ceiling.
  const MAX_WEBRTC_FPS = 60;
  const WEBRTC_VIDEO_FPS = Math.min(MAX_WEBRTC_FPS, Math.max(1, Math.round(refreshHz)));
  const webrtcFfmpegArgs = {
    video: (port: number) => [
      "-hide_banner",
      // "warning" (not "error") deliberately: this is the diagnostic level
      // that surfaces libx264's `MB rate (...) > level limit (...)` warning
      // if a future resolution/fps/level combination ever becomes
      // non-conformant again (see the -level comment below) — "error" would
      // silently swallow that signal, which is exactly what happened before
      // this was caught by empirical UDP-packet verification rather than by
      // the logs. Verified quiet in the healthy case: running this exact
      // command at level 6.0 against the real capture produced no warning
      // spam, only normal per-frame -stats output.
      "-loglevel", "warning",
      ...screenCaptureInputArgs(WEBRTC_VIDEO_FPS),
      // Screen-capture inputs deliver packed RGB/422 formats (gdigrab->bgra,
      // x11grab->bgr0, avfoundation->uyvy422). Without an explicit pix_fmt,
      // ffmpeg's automatic negotiation picks yuv444p/yuv422p, neither of
      // which isn't legal for the H.264 profile below, so libx264 fails to init.
      "-pix_fmt", "yuv420p",
      // Screen-capture inputs (especially avfoundation) ignore -framerate and
      // emit as fast as possible (see capture/ffmpeg.ts); -vf fps=... is what
      // actually caps the output rate, mirroring Classic capture's use of it.
      "-vf", `fps=${WEBRTC_VIDEO_FPS}`,
      "-c:v", "libx264",
      "-profile:v", "high",
      // Must stay in sync with the profile-level-id byte pair in
      // webrtc/codecs.ts's VIDEO_CODEC (profile 0x64 = High, level 0x34 =
      // level 5.2). Levels 3.1/4.0/5.1/6.0 were all tried in earlier rounds
      // of this fix and tuned purely against libx264's encode-side
      // leniency (it warns but keeps producing RTP packets when nominally
      // over a level's macroblock-rate budget) — but level 6.0, in ANY
      // profile, isn't supported by Chrome's WebRTC decoder at all,
      // confirmed via Chrome's own RTCRtpSender.getCapabilities('video')
      // capability list, which tops out at High profile / level 5.2
      // (profile-level-id 640034). Offering level 6.0 made Chrome answer
      // with zero video codecs and werift's setRemoteDescription() threw
      // "negotiate codecs failed." deterministically, every time. Level 5.2
      // is the highest level+profile Chrome actually supports, so it's what
      // this app declares now — see codecs.ts's VIDEO_CODEC comment for the
      // full arithmetic and the task11 fix report for the real-Chrome
      // decode verification (framesDecoded increasing over time) and the
      // MAX_WEBRTC_FPS ceiling that verification settled on.
      "-level", "5.2",
      "-preset", "ultrafast",
      "-tune", "zerolatency",
      "-f", "rtp",
      `rtp://127.0.0.1:${port}`,
    ],
    audio: (port: number) => [
      "-hide_banner",
      "-loglevel", "error",
      ...(loopback
        ? ["-f", loopback.format, "-i", loopback.device]
        // No loopback device detected: feed throttled silence rather than
        // failing the whole WebRTC session over a missing audio source
        // (mirrors AudioCapture's "unsupported" honesty for Classic mode —
        // handleStartWebrtc separately reports this via agentError — but the
        // WebRTC audio track just carries silence instead of not existing).
        // -re paces the lavfi source at wall-clock rate; without it ffmpeg
        // would generate/encode silence as fast as possible, since neither
        // lavfi nor the rtp muxer throttle on their own.
        : ["-re", "-f", "lavfi", "-i", "anullsrc=channel_layout=mono:sample_rate=48000"]),
      "-ac", "1",
      "-ar", "48000",
      "-c:a", "libopus",
      "-payload_type", "111",
      "-f", "rtp",
      `rtp://127.0.0.1:${port}`,
    ],
  };

  // `server` is referenced by the lock manager's onChange (declared before it
  // exists), so use a holder the arrow can read once it's assigned.
  let server: ConnectionServer;
  const inputLock = new InputLockManager({
    backend: createInputLockBackend(),
    autoReleaseMs: INPUT_LOCK_AUTO_RELEASE_MS,
    onChange: (locked) => server?.notifyLockState(locked),
  });

  server = new ConnectionServer({
    secret: config.secret,
    nickname: config.nickname,
    port: config.port,
    tls: { cert: tls.cert, key: tls.key },
    input,
    capture,
    typingBackend,
    inputLock,
    audio,
    refreshHz,
    webrtcFfmpegArgs,
  });

  await server.listen();
  printBanner(config.port, config.secret, tls.fingerprint, captureKind, isElevated());

  // Optional agent-side toggle hotkey (Ctrl+Alt+L); no-ops if unavailable.
  const hotkey = await registerLockHotkey(() => void inputLock.toggle());

  const shutdown = async (): Promise<void> => {
    process.stdout.write("\nShutting down…\n");
    hotkey.stop();
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

function printBanner(
  port: number,
  secret: string,
  fingerprint: string,
  captureKind: string,
  elevated: boolean,
): void {
  const { lan, tailscale } = localAddresses();
  const lines: string[] = [];
  lines.push("");
  lines.push("  Back Connector — agent is running");
  lines.push("  ─────────────────────────────────");
  lines.push(`  Port:        ${port}`);
  lines.push(`  Secret:      ${secret}`);
  lines.push(`  Cert SHA-256:${fingerprint}`);
  lines.push(`  Capture:     ${captureKind}`);
  lines.push("");
  lines.push("  Connect from the client using one of:");
  for (const ip of lan) lines.push(`    LAN:       ${ip}:${port}`);
  for (const ip of tailscale) lines.push(`    Tailscale: ${ip}:${port}`);
  if (lan.length === 0 && tailscale.length === 0) {
    lines.push("    (no LAN/Tailscale IPv4 address detected)");
  }
  // isElevated() only reports false on a non-elevated Windows agent, where
  // BlockInput would be silently refused. Warn so the user isn't surprised when
  // "Lock agent's local input" fails.
  if (!elevated) {
    lines.push("");
    lines.push("  ⚠ Not running as Administrator — 'Lock agent's local input'");
    lines.push("    will be refused by Windows. Restart this agent from a terminal");
    lines.push("    opened with 'Run as administrator' to enable it.");
  }
  lines.push("");
  process.stdout.write(lines.join("\n") + "\n");
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${String(err)}\n`);
  process.exit(1);
});
