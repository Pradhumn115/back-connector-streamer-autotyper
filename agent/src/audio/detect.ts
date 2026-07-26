import { spawnSync } from "node:child_process";
import { platform } from "node:os";

/**
 * A system-audio loopback source described as ffmpeg arguments.
 *  - format: the ffmpeg input format (`-f <format>`): avfoundation | dshow | pulse
 *  - device: the `-i <device>` argument to read the loopback from
 */
export interface LoopbackDevice {
  format: string;
  device: string;
}

// ---- pure parsers (unit-testable, no process spawning) ----

/**
 * From `ffmpeg -f avfoundation -list_devices true -i ""` output, return the
 * audio-device index of BlackHole (any channel count), or null. Only the audio
 * section is searched, since video devices share the same [n] index space.
 */
export function parseMacBlackHoleIndex(listOutput: string): string | null {
  let inAudio = false;
  for (const line of listOutput.split("\n")) {
    if (/AVFoundation audio devices:/i.test(line)) {
      inAudio = true;
      continue;
    }
    if (/AVFoundation video devices:/i.test(line)) {
      inAudio = false;
      continue;
    }
    if (!inAudio) continue;
    const m = line.match(/\[(\d+)\]\s+(.*\bBlackHole\b.*)$/i);
    if (m) return m[1];
  }
  return null;
}

/**
 * Recognized loopback-capable device names on Windows, checked in this
 * priority order (most reliable/common first):
 *  - VB-Cable's "CABLE Output (VB-Audio Virtual Cable)" (the free single-cable
 *    product this project's README/setup script installs)
 *  - "CABLE-A Output"/"CABLE-B Output" (the paid VB-Cable A+B pack -- same
 *    vendor, different product, same loopback pattern)
 *  - VoiceMeeter's virtual outputs ("VoiceMeeter Output", "VoiceMeeter Aux
 *    Output", "VoiceMeeter VAIO3 Output") -- a different VB-Audio product
 *    some users already have installed for other reasons
 *  - screen-capture-recorder's "virtual-audio-capturer"
 *  - Windows' own built-in "Stereo Mix" -- present (though often disabled by
 *    default) on many onboard sound chips, needing no extra driver install at
 *    all when available
 */
const WINDOWS_LOOPBACK_PATTERNS = [
  /cable output/i,
  /cable-[ab] output/i,
  /voicemeeter(?:\s+\w+)?\s+output/i,
  /virtual-audio-capturer/i,
  /stereo mix/i,
];

/**
 * From `ffmpeg -f dshow -list_devices true -i dummy` output, return the exact
 * quoted name of a loopback-capable audio device (see
 * WINDOWS_LOOPBACK_PATTERNS), or null. Only the friendly-name line for each
 * device is considered -- ffmpeg also prints an "Alternative name" line
 * (an opaque device path) directly below it, which this skips by returning
 * on the first quoted match once inAudio is true rather than scanning every
 * quoted string in the section.
 */
export function parseWindowsLoopbackName(listOutput: string): string | null {
  let inAudio = false;
  for (const line of listOutput.split("\n")) {
    if (/DirectShow audio devices/i.test(line)) {
      inAudio = true;
      continue;
    }
    if (/DirectShow video devices/i.test(line)) {
      inAudio = false;
      continue;
    }
    if (!inAudio) continue;
    if (/Alternative name/i.test(line)) continue;
    const m = line.match(/"([^"]+)"/);
    if (!m) continue;
    const name = m[1];
    if (WINDOWS_LOOPBACK_PATTERNS.some((p) => p.test(name))) {
      return name;
    }
  }
  return null;
}

// ---- OS probes (spawn ffmpeg / pactl) ----

/** Run ffmpeg's device list; its output goes to stderr. Returns "" on failure. */
function ffmpegListDevices(format: string, inputArg: string): string {
  try {
    const res = spawnSync(
      "ffmpeg",
      ["-hide_banner", "-f", format, "-list_devices", "true", "-i", inputArg],
      { encoding: "utf8" },
    );
    return `${res.stdout ?? ""}${res.stderr ?? ""}`;
  } catch {
    return "";
  }
}

/**
 * Detect a system-audio loopback source for the current OS, or null if none is
 * available (so the agent can report the feature unsupported honestly).
 */
export function detectLoopbackDevice(): LoopbackDevice | null {
  switch (platform()) {
    case "darwin": {
      const idx = parseMacBlackHoleIndex(ffmpegListDevices("avfoundation", ""));
      // avfoundation "-i :<idx>" selects audio-only (empty video part).
      return idx === null ? null : { format: "avfoundation", device: `:${idx}` };
    }
    case "win32": {
      const listing = ffmpegListDevices("dshow", "dummy");
      const name = parseWindowsLoopbackName(listing);
      if (name === null) {
        // No pattern in WINDOWS_LOOPBACK_PATTERNS matched anything ffmpeg's
        // dshow backend actually sees. Dumping the raw listing here is the
        // difference between "install a driver and hope" and actually seeing
        // whether e.g. VB-Cable installed under a name this doesn't
        // recognize yet, or dshow enumerated zero audio devices at all
        // (common right after installing a driver without a reboot, or when
        // this process started before the driver was installed).
        process.stderr.write(
          "[audio] no loopback device recognized; raw ffmpeg dshow device list:\n" +
            `${listing || "(empty -- ffmpeg produced no output)"}\n`,
        );
        return null;
      }
      return { format: "dshow", device: `audio=${name}` };
    }
    default: {
      // Linux: the default sink's monitor. Prefer resolving the real name; fall
      // back to the PulseAudio special token if pactl is unavailable.
      try {
        const res = spawnSync("pactl", ["get-default-sink"], { encoding: "utf8" });
        const sink = (res.stdout ?? "").trim();
        if (res.status === 0 && sink) {
          return { format: "pulse", device: `${sink}.monitor` };
        }
      } catch {
        /* fall through */
      }
      return null;
    }
  }
}
