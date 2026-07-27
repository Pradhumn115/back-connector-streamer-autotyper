import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Reads and sets the agent machine's own output volume.
 *
 * ## Why this is not the same as the client's volume slider
 *
 * The client already has one, and it only changes what the person at the
 * browser hears. This changes what the remote machine is actually doing: mute
 * here and the speakers in that room go quiet, for anyone standing next to
 * them. That is the intent — it is the control you would reach for if you were
 * sitting at the machine — but it is why the two are separate and separately
 * labelled, rather than one slider that silently does both.
 *
 * ## Why shelling out rather than a native binding
 *
 * Every platform exposes this through a different system API, and a native
 * addon for each would have to be built and shipped per platform — for a
 * feature that adjusts a number. The command-line route each OS already
 * provides costs one short-lived process per change, which is imperceptible
 * against a control a human is dragging.
 *
 * Arguments are passed as an array through `execFile`, never interpolated into
 * a shell string: the level reaches here from the network, and building a shell
 * command out of remote input is how a volume control becomes a way to run
 * arbitrary commands. It is validated as a number first as well, but the
 * argument-array form means neither check depends on the other.
 */
export interface OutputVolume {
  /** 0..100. */
  level: number;
  muted: boolean;
}

export interface VolumeController {
  readonly supported: boolean;
  get(): Promise<OutputVolume | null>;
  setLevel(level: number): Promise<void>;
  setMuted(muted: boolean): Promise<void>;
}

/** Clamp to the wire range and drop any fractional part the OS will not take. */
function clampLevel(level: number): number {
  // Only NaN has no position on the scale. The infinities do — they are the
  // ends of it — so they clamp like any other out-of-range number rather than
  // collapsing to silence, which would be a surprising thing for "max" to mean.
  if (Number.isNaN(level)) return 0;
  return Math.max(0, Math.min(100, Math.round(level)));
}

class MacVolumeController implements VolumeController {
  readonly supported = true;

  async get(): Promise<OutputVolume | null> {
    try {
      // Each value is coerced with `as text` before being joined. Without it
      // AppleScript's `&` on a number builds a LIST rather than concatenating,
      // and osascript prints that as "25, ,, true" — so splitting on the comma
      // finds a space where the mute flag should be, and the machine always
      // reads as unmuted. The volume still parses out of the first field, which
      // is what made the bug look like a working control.
      const { stdout } = await run("osascript", [
        "-e",
        "(output volume of (get volume settings) as text) & \",\" &" +
          " (output muted of (get volume settings) as text)",
      ]);
      const [rawLevel, rawMuted] = stdout.trim().split(",");
      const level = Number(rawLevel);
      if (!Number.isFinite(level)) return null;
      return { level: clampLevel(level), muted: rawMuted?.trim() === "true" };
    } catch {
      return null;
    }
  }

  async setLevel(level: number): Promise<void> {
    // Setting a level while muted leaves the machine silent at the new volume,
    // which reads as "the control did nothing". Unmuting matches what the
    // hardware keys do.
    await run("osascript", [
      "-e",
      `set volume output volume ${clampLevel(level)} without output muted`,
    ]);
  }

  async setMuted(muted: boolean): Promise<void> {
    await run("osascript", ["-e", `set volume output muted ${muted ? "true" : "false"}`]);
  }
}

class PulseVolumeController implements VolumeController {
  readonly supported = true;

  async get(): Promise<OutputVolume | null> {
    try {
      const [volume, mute] = await Promise.all([
        run("pactl", ["get-sink-volume", "@DEFAULT_SINK@"]),
        run("pactl", ["get-sink-mute", "@DEFAULT_SINK@"]),
      ]);
      // "Volume: front-left: 32768 /  50% / -18.06 dB, ..." — the first
      // percentage is the one the user thinks of as "the volume".
      const percent = volume.stdout.match(/(\d+)%/);
      if (!percent) return null;
      return {
        level: clampLevel(Number(percent[1])),
        muted: /:\s*yes/i.test(mute.stdout),
      };
    } catch {
      return null;
    }
  }

  async setLevel(level: number): Promise<void> {
    await run("pactl", ["set-sink-volume", "@DEFAULT_SINK@", `${clampLevel(level)}%`]);
    await run("pactl", ["set-sink-mute", "@DEFAULT_SINK@", "0"]);
  }

  async setMuted(muted: boolean): Promise<void> {
    await run("pactl", ["set-sink-mute", "@DEFAULT_SINK@", muted ? "1" : "0"]);
  }
}

/** Reports honestly that nothing can be done, rather than failing silently. */
class UnsupportedVolumeController implements VolumeController {
  readonly supported = false;
  async get(): Promise<OutputVolume | null> {
    return null;
  }
  async setLevel(): Promise<void> {}
  async setMuted(): Promise<void> {}
}

/**
 * Pick a controller for this platform.
 *
 * Windows is deliberately unsupported rather than approximated. It has no
 * command-line volume control in the base install: the usual workarounds are a
 * third-party binary the user would have to install, or synthesising the
 * keyboard's mute key — which toggles rather than sets, so the agent could
 * never report a level it had not guessed. Reporting the feature as
 * unavailable is more useful than a slider that lies about what it did.
 */
export async function detectVolumeController(): Promise<VolumeController> {
  if (process.platform === "darwin") return new MacVolumeController();
  if (process.platform === "linux") {
    try {
      await run("pactl", ["--version"]);
      return new PulseVolumeController();
    } catch {
      return new UnsupportedVolumeController();
    }
  }
  return new UnsupportedVolumeController();
}

export { MacVolumeController, PulseVolumeController, UnsupportedVolumeController, clampLevel };
