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
  const maxWidth = process.env.BCSA_MAX_WIDTH ? Number(process.env.BCSA_MAX_WIDTH) : 1440;
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
  // MAX_WEBRTC_FPS is intentionally NOT 120 (Classic's MAX_FPS): unlike
  // FfmpegCapture (which scales its output to `maxWidth` before encoding),
  // this WebRTC pipeline captures and encodes at the display's *native*
  // resolution (no `-vf scale`). H.264 level 4.0 (see the -level flag below
  // and webrtc/codecs.ts) has a fixed macroblock-rate budget of 245,760
  // MB/s. For the real device this code was tested against (1728x1117,
  // called out in the -level comment below), that's 108x70 = 7,560
  // macroblocks/frame, so the level-4.0 ceiling is only ~32.5fps at that
  // resolution — and for larger/4K-class native resolutions the safe fps is
  // far lower still (e.g. ~1080p is already only good for ~30fps; ~1440p
  // for ~17fps). Raising this cap to Classic's 120 (or even 60) would
  // silently exceed level 4.0's budget on exactly the resolutions this app
  // targets, reproducing the silent libx264 hang that motivated switching
  // from level 3.1 to 4.0 in the first place (see below). 30 is the largest
  // ceiling verified safe at the tested real capture resolution, so it's
  // kept as the cap; only the *lower* bound now truly varies with the
  // display's refresh rate (e.g. a sub-30Hz display now correctly targets
  // its own rate instead of blindly encoding at a fixed 30fps). Unlocking a
  // higher genuine ceiling would require either bumping past level 4.0
  // (more decoder-compat risk) or scaling WebRTC's capture resolution down
  // like FfmpegCapture already does — both out of scope here.
  const MAX_WEBRTC_FPS = 30;
  const WEBRTC_VIDEO_FPS = Math.min(MAX_WEBRTC_FPS, Math.max(1, Math.round(refreshHz)));
  const webrtcFfmpegArgs = {
    video: (port: number) => [
      "-hide_banner",
      "-loglevel", "error",
      ...screenCaptureInputArgs(WEBRTC_VIDEO_FPS),
      // Screen-capture inputs deliver packed RGB/422 formats (gdigrab->bgra,
      // x11grab->bgr0, avfoundation->uyvy422). Without an explicit pix_fmt,
      // ffmpeg's automatic negotiation picks yuv444p/yuv422p, neither of
      // which is legal under `-profile:v baseline`, so libx264 fails to init.
      "-pix_fmt", "yuv420p",
      // Screen-capture inputs (especially avfoundation) ignore -framerate and
      // emit as fast as possible (see capture/ffmpeg.ts); -vf fps=... is what
      // actually caps the output rate, mirroring Classic capture's use of it.
      "-vf", `fps=${WEBRTC_VIDEO_FPS}`,
      "-c:v", "libx264",
      "-profile:v", "baseline",
      // Must stay in sync with the profile-level-id level byte in
      // webrtc/codecs.ts's VIDEO_CODEC (0x28 = level 4.0). Level 3.1 was
      // tried first but its macroblock-rate limit can't sustain real screen
      // capture resolutions (e.g. 1728x1117@30fps) — libx264 silently hangs
      // instead of erroring, so it never emits RTP output. See codecs.ts.
      "-level", "4.0",
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
