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
  /**
   * Whether the agent can read and set its own output volume, and where it
   * currently is. Passed in rather than probed here so the panel reports the
   * controller the server is really using, including one that failed its
   * startup probe on a locked-down machine.
   */
  outputVolume?: { supported: boolean; level: number; muted: boolean } | null;
  /** Encoder actually in use (h264_videotoolbox, libx264, ...), when known. */
  videoEncoder?: string | null;
  /** Current encode size and rate, which the adaptive controller may have changed. */
  videoWidth?: number | null;
  videoFps?: number | null;
  /**
   * The QUIC/WebTransport video listener's port, or null if it did not start.
   *
   * Reported because its absence is otherwise invisible: video silently falls
   * back to the WebSocket, which works, so nothing tells the user they lost
   * QUIC's loss tolerance until the picture stutters on a lossy link.
   */
  webtransportPort?: number | null;
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

  checks.push(
    ctx.webtransportPort
      ? {
          id: "video-transport",
          label: "Video transport",
          status: "ok",
          detail: `QUIC on UDP ${ctx.webtransportPort}, with WebSocket fallback`,
        }
      : {
          id: "video-transport",
          label: "Video transport",
          status: "warn",
          detail: "WebSocket only — the QUIC listener did not start",
          fix:
            "Video still works. QUIC avoids TCP head-of-line blocking, which matters " +
            "on a lossy link; check that UDP isn't blocked and the port is free.",
        },
  );

  checks.push({
    id: "capture-engine",
    label: "Screen capture engine",
    status: ctx.captureKind?.startsWith("screenshot-desktop") ? "warn" : "ok",
    detail: [
      ctx.captureKind ??
        (hasFfmpeg ? `ffmpeg pipeline — targets ~${ctx.refreshHz}fps` : "screenshot-desktop"),
      ctx.videoEncoder ? `encoder ${ctx.videoEncoder}` : null,
      ctx.videoWidth && ctx.videoFps ? `${ctx.videoWidth}px @ ${ctx.videoFps}fps` : null,
    ]
      .filter(Boolean)
      .join(" · "),
    fix: ctx.captureKind?.startsWith("screenshot-desktop")
      ? "Install ffmpeg (see above) for high-fps video."
      : undefined,
  });

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
  checks.push(volumeCheck(ctx));

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

/**
 * Reports whether the remote machine's own volume can be driven from here.
 *
 * Separate from the audio-loopback check above, because the two are unrelated
 * in both directions: a machine with no loopback device can still have its
 * volume changed, and a machine that captures audio perfectly may not let
 * anyone set it. Reporting them together would make each look like a symptom
 * of the other.
 */
function volumeCheck(ctx: DiagContext): DiagnosticCheck {
  const label = "Agent volume control";
  const v = ctx.outputVolume;
  if (v?.supported) {
    return {
      id: "output-volume",
      label,
      status: "ok",
      detail: `${v.level}%${v.muted ? " · muted" : ""}`,
    };
  }
  // Every platform is implemented using what the OS already ships, so an
  // unsupported result means something specific failed rather than "not built
  // yet" — the fix names the thing to check on each.
  const fix =
    os === "win32"
      ? "The agent drives volume through PowerShell's Add-Type (no install needed). This usually means PowerShell could not compile it — check that powershell.exe runs and that an execution policy or hardened configuration is not blocking Add-Type."
      : os === "linux"
        ? "Install PulseAudio/PipeWire tooling so `pactl` is on PATH (e.g. `sudo apt install pulseaudio-utils`)."
        : "The agent uses osascript, which ships with macOS. Check that osascript runs and that the terminal is permitted to control the system.";
  return {
    id: "output-volume",
    label,
    status: "warn",
    detail: "cannot read or set this machine's output volume",
    fix,
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
