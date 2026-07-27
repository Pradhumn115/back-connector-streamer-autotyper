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
import type { VideoCodecTier } from "./webrtc/codecs.js";
import { buildVideoFilter } from "./webrtc/videoFilter.js";
import { H264Capture, h264CaptureAvailable } from "./capture/h264.js";
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
  // H.264 is the default video path, with the older MJPEG paths as fallbacks.
  //
  // Same transport and same frame envelope as Classic — only the codec differs.
  // Measured on a real desktop: ~7.4KB/frame (~1.8 Mbit/s) against MJPEG's
  // ~267KB/frame (~63 Mbit/s), because H.264 sends only what changed while
  // every JPEG is intra-coded. It also captures via ScreenCaptureKit on macOS
  // rather than the legacy avfoundation route, which has been observed failing
  // outright ("Selected pixel format is not supported by the input device",
  // respawning without ever producing a frame) on machines where the in-process
  // path works fine.
  //
  // Availability is probed rather than assumed, because a missing screen
  // permission, a node-av build without an encoder, or a hardware encoder that
  // rejects these options are all only answerable by trying — and each must
  // degrade to a working path instead of a black screen.
  //
  // BCSA_H264=0 forces the old path, for comparing the two.
  const h264Wanted = process.env.BCSA_H264 !== "0";
  if (h264Wanted && (await h264CaptureAvailable())) {
    capture = new H264Capture({ width: maxWidth, fps: Math.min(30, refreshHz) });
    captureKind = `h264 in-process (max width ${maxWidth}px)`;
  } else if (ffmpegAvailable()) {
    capture = new FfmpegCapture({ maxWidth });
    captureKind = `ffmpeg MJPEG (targets display refresh ~${refreshHz}fps, max width ${maxWidth}px)`;
  } else {
    capture = new CaptureLoop(createScreenshotCapture());
    captureKind = "screenshot-desktop (install ffmpeg for higher fps)";
  }

  // WebRTC ffmpeg args: same per-OS screen-capture input as FfmpegCapture and
  // the same loopback-device detection as AudioCapture (see capture/ffmpeg.ts
  // and audio/detect.ts) — only the output tail differs (RTP + libx264/libopus
  // instead of MJPEG-over-pipe/raw-PCM-over-pipe).
  //
  // The video encode is codec-tier-adaptive (see webrtc/codecs.ts's
  // VIDEO_CODEC_TIERS): the offer lists multiple H.264 profile/level
  // combinations, the browser's SDP answer picks whichever one its decoder
  // actually supports, and WebrtcSession (session.ts's setAnswer()) calls
  // videoFfmpegArgsFor() with the winning tier only after that's known — so
  // the ffmpeg command line's -profile:v/-level/resolution-cap/fps-cap must
  // all come from the tier, not be hardcoded here. This replaced an earlier
  // single-fixed-codec design that kept breaking one browser or another:
  // raising the level (3.1 -> 4.0 -> 5.1 -> 6.0, then High/5.2) chased this
  // machine's native capture resolution, but level 6.0 isn't supported by
  // Chrome's WebRTC decoder at all (confirmed via
  // RTCRtpSender.getCapabilities('video')), and level 5.2 (Chrome's own
  // ceiling) isn't in Safari's decoder capability list either — there's no
  // single level every browser supports above 3.1. Offering both tiers
  // lets each browser negotiate the best one it actually supports.
  const webrtcFfmpegArgs = {
    video: (tier: VideoCodecTier, port: number) => [
      "-hide_banner",
      // "warning" (not "error") deliberately: this is the diagnostic level
      // that surfaces libx264's `MB rate (...) > level limit (...)` warning
      // if a tier's resolution/fps/level combination is ever
      // non-conformant — "error" would silently swallow that signal, which
      // is exactly what happened before this was caught by empirical
      // UDP-packet verification rather than by the logs.
      "-loglevel", "warning",
      ...screenCaptureInputArgs(tier.maxFps),
      // Screen-capture inputs deliver packed RGB/422 formats (gdigrab->bgra,
      // x11grab->bgr0, avfoundation->uyvy422). Without an explicit pix_fmt,
      // ffmpeg's automatic negotiation picks yuv444p/yuv422p, neither of
      // which isn't legal for the H.264 profile below, so libx264 fails to init.
      "-pix_fmt", "yuv420p",
      // Caps fps and guarantees even output dimensions — see buildVideoFilter
      // for why both matter (libx264/yuv420p rejects odd sizes outright).
      "-vf", buildVideoFilter(tier),
      // Encoder selection and tuning come from the tier, not from here.
      //
      // The tiers are no longer all H.264 — VP8 is offered as a universal
      // fallback for clients with no H.264 decoder at all (Firefox), and it
      // shares none of x264's profile/level/threading vocabulary. Anything
      // hardcoded at this level would be wrong for one codec or the other.
      // See VideoCodecTier.encoderArgs, which also carries the settings that
      // make each encoder actually emit what its SDP advertises.
      ...tier.encoderArgs,
      // Bounded GOP -- one IDR per second of output.
      //
      // `-tune zerolatency` leaves the keyframe interval effectively
      // unbounded: measured directly, these exact args without `-g` produce
      // ONE I-frame for the whole stream (150 frames encoded -> `frame I:1
      // frame P:149`), so the only recovery point a receiver ever gets is
      // the very first frame. Any loss of that frame -- or of any packet
      // afterwards -- leaves the browser decoding P-frames against a
      // reference it does not have, forever. That is a permanently black
      // <video> on a peer connection that reports itself connected.
      //
      // A receiver's remedy for exactly this is a PLI ("send me a
      // keyframe"), which werift surfaces as
      // `sender.onPictureLossIndication`. ffmpeg has no way to be asked for
      // an IDR on demand mid-run, so a bounded GOP is what actually answers
      // those PLIs: recovery is capped at one second instead of never.
      "-g", String(tier.maxFps),
      // See VideoCodecTier.maxBitrateKbps -- an uncapped CRF encode bursts
      // far past what the link can carry, and nothing here reacts to
      // congestion. bufsize is half the rate cap to keep the rate-control
      // window short, which suits low latency.
      "-b:v", `${tier.maxBitrateKbps}k`,
      "-maxrate", `${tier.maxBitrateKbps}k`,
      "-bufsize", `${Math.round(tier.maxBitrateKbps / 2)}k`,
      // Cap the RTP payload well under a 1500-byte path MTU.
      //
      // ffmpeg's rtp muxer defaults to 1472-byte UDP payloads (measured:
      // 1472 without this flag, 1200 with it). werift then SRTP-encrypts
      // each one, appending an auth tag, and the UDP+IP headers add 28 more
      // -- so the default puts ~1510 bytes on the wire, over standard
      // Ethernet's 1500 MTU and far over Tailscale's 1280. The result is IP
      // fragmentation or outright drops on precisely the links this tool is
      // meant to run over, and with the pre-fix single-keyframe stream above,
      // one dropped fragment killed the session permanently.
      "-pkt_size", "1200",
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
