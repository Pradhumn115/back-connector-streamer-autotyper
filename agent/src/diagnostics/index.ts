import { platform, release } from "node:os";
import type { DiagnosticCheck } from "@bcsa/shared";
import { ffmpegAvailable } from "../capture/ffmpeg.js";
import { isElevated } from "../inputlock/elevation.js";

export interface DiagContext {
  /**
   * The capture engine actually selected at startup, as reported in the agent
   * banner. Passed in rather than re-derived, so this panel cannot disagree
   * with what is really running — it previously always claimed "ffmpeg
   * pipeline" even when a different engine had been chosen.
   */
  captureKind?: string;
  /** Detected display refresh rate (Hz). */
  refreshHz: number;
  /** Whether the OS input-lock backend is implemented for this platform. */
  inputLockSupported: boolean;
  /** Whether a system-audio loopback device was found. */
  audioSupported: boolean;
  /** Detected screen size, or null if screen access failed. */
  screenSize: { width: number; height: number } | null;
}

const os = platform();
const osName = os === "darwin" ? "macOS" : os === "win32" ? "Windows" : "Linux";

/**
 * Run agent-side self-diagnostics. Pure(ish): reads the environment (which
 * tools are installed, permission-dependent capabilities), never installs or
 * executes anything on behalf of the client — every fix is text guidance.
 */
export function runDiagnostics(ctx: DiagContext): DiagnosticCheck[] {
  const checks: DiagnosticCheck[] = [];
  const hasFfmpeg = ffmpegAvailable();

  checks.push({
    id: "runtime",
    label: "Agent runtime",
    status: "ok",
    detail: `${osName} · Node ${process.versions.node} · kernel ${release()}`,
  });

  checks.push(
    hasFfmpeg
      ? { id: "ffmpeg", label: "ffmpeg (video + audio)", status: "ok", detail: "installed" }
      : {
          id: "ffmpeg",
          label: "ffmpeg (video + audio)",
          status: "warn",
          detail: "not found — video falls back to a slow per-frame path, and audio capture is unavailable",
          fix: "Run `npm run setup` on the agent to install ffmpeg (then restart the agent; on Windows open a new terminal first).",
        },
  );

  checks.push({
    id: "capture-engine",
    label: "Screen capture engine",
    status: ctx.captureKind?.startsWith("screenshot-desktop") ? "warn" : "ok",
    detail:
      ctx.captureKind ??
      (hasFfmpeg ? `ffmpeg pipeline — targets ~${ctx.refreshHz}fps` : "screenshot-desktop"),
    fix: ctx.captureKind?.startsWith("screenshot-desktop")
      ? "Install ffmpeg (see above) for high-fps video."
      : undefined,
  });

  checks.push(
    hasFfmpeg
      ? {
          id: "webrtc",
          label: "WebRTC transport (H.264 + Opus)",
          status: "ok",
          detail: "ready (werift + ffmpeg RTP) — the H.264-over-WebSocket path does not need it",
        }
      : {
          id: "webrtc",
          label: "WebRTC transport (H.264 + Opus)",
          status: "warn",
          detail: "unavailable — the RTP relay needs ffmpeg (Classic mode still works)",
          fix: "Install ffmpeg (`npm run setup`) to enable the WebRTC transport.",
        },
  );

  checks.push(
    ctx.screenSize
      ? {
          id: "screen-access",
          label: "Screen access",
          status: "ok",
          detail: `${ctx.screenSize.width}×${ctx.screenSize.height} @ ${ctx.refreshHz}Hz`,
        }
      : {
          id: "screen-access",
          label: "Screen access",
          status: "fail",
          detail: "couldn't read the screen size — capture/input may be blocked by OS permissions",
          fix:
            os === "darwin"
              ? "Grant the agent's terminal Screen Recording AND Accessibility permission (System Settings → Privacy & Security), then restart it."
              : "Ensure the agent can access the desktop session (on Linux, an X11 session; Wayland input is limited).",
        },
  );

  checks.push(inputLockCheck(ctx));
  checks.push(audioCheck(ctx));

  return checks;
}

function inputLockCheck(ctx: DiagContext): DiagnosticCheck {
  if (!ctx.inputLockSupported) {
    return {
      id: "input-lock",
      label: "Lock agent's local input",
      status: "warn",
      detail: `not available on ${osName} yet`,
      fix:
        os === "linux"
          ? "Not implemented on Linux (needs EVIOCGRAB). The feature is disabled; everything else works."
          : "This OS backend isn't built. On macOS run `npm run setup` to build the input-lock helper.",
    };
  }
  if (os === "win32" && !isElevated()) {
    return {
      id: "input-lock",
      label: "Lock agent's local input",
      status: "warn",
      detail: "supported, but the agent isn't elevated — Windows will refuse BlockInput",
      fix: "Restart the agent from a terminal opened with 'Run as administrator'.",
    };
  }
  return {
    id: "input-lock",
    label: "Lock agent's local input",
    status: "ok",
    detail: "supported and ready",
  };
}

function audioCheck(ctx: DiagContext): DiagnosticCheck {
  if (ctx.audioSupported) {
    return {
      id: "audio-loopback",
      label: "System-audio capture (transcription)",
      status: "ok",
      detail: "loopback device found",
    };
  }
  const fix =
    os === "darwin"
      ? "Install BlackHole (`npm run setup`), then in Audio MIDI Setup create a Multi-Output Device (speakers + BlackHole) and select it as output. Also grant the terminal Microphone permission. See README."
      : os === "win32"
        ? "Install VB-Cable (`npm run setup`), reboot, set CABLE Input as the output device, and enable 'Listen to this device' on CABLE Output. See README."
        : "Ensure PulseAudio/PipeWire is running (`pactl` must be available); the default sink's monitor is used automatically.";
  return {
    id: "audio-loopback",
    label: "System-audio capture (transcription)",
    status: "warn",
    detail: "no loopback device found — transcription is unavailable",
    fix,
  };
}
