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
 * From `ffmpeg -f dshow -list_devices true -i dummy` output, return the exact
 * quoted name of a loopback audio device (VB-Cable's "CABLE Output ..." or the
 * screen-capture-recorder "virtual-audio-capturer"), or null.
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
    const m = line.match(/"([^"]+)"/);
    if (!m) continue;
    const name = m[1];
    if (/cable output/i.test(name) || /virtual-audio-capturer/i.test(name)) {
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
      const name = parseWindowsLoopbackName(ffmpegListDevices("dshow", "dummy"));
      return name === null ? null : { format: "dshow", device: `audio=${name}` };
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
