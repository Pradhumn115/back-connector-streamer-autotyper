import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// agent/{src,dist}/display.* -> agent/native/bin/bcsa-inputlock-mac
const MAC_HELPER = join(__dirname, "..", "native", "bin", "bcsa-inputlock-mac");

const FALLBACK_HZ = 60;
const MIN_HZ = 24;
const MAX_HZ = 240;

let cached: number | null = null;

/**
 * Best-effort detection of the primary display's refresh rate (Hz). Used to
 * target the streaming frame rate at what the screen can actually show. Falls
 * back to 60 if detection fails. Result is cached (queried once per process).
 */
export function detectRefreshHz(): number {
  if (cached !== null) return cached;
  cached = clamp(probe()) ?? FALLBACK_HZ;
  return cached;
}

function clamp(hz: number | null): number | null {
  if (hz === null || !Number.isFinite(hz)) return null;
  if (hz < MIN_HZ || hz > MAX_HZ) return null;
  return Math.round(hz);
}

function probe(): number | null {
  try {
    switch (platform()) {
      case "darwin":
        return probeMac();
      case "win32":
        return probeWindows();
      default:
        return probeLinux();
    }
  } catch {
    return null;
  }
}

function probeMac(): number | null {
  // Preferred: our Swift helper via CVDisplayLink (accurate for built-in panels,
  // which system_profiler often omits and CGDisplayModeGetRefreshRate reports 0).
  if (existsSync(MAC_HELPER)) {
    const res = spawnSync(MAC_HELPER, ["refresh"], { encoding: "utf8", timeout: 5000 });
    const hz = Number((res.stdout ?? "").trim());
    if (Number.isFinite(hz) && hz > 0) return hz;
  }
  // Fallback: parse system_profiler if it happens to include a Hz line.
  const res = spawnSync("system_profiler", ["SPDisplaysDataType"], {
    encoding: "utf8",
    timeout: 5000,
  });
  const rates = [...(res.stdout ?? "").matchAll(/(?:@\s*|Refresh Rate:\s*)([\d.]+)\s*Hz/gi)].map(
    (m) => Number(m[1]),
  );
  return rates.length ? Math.max(...rates) : null;
}

function probeWindows(): number | null {
  const res = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "(Get-CimInstance -ClassName Win32_VideoController).CurrentRefreshRate",
    ],
    { encoding: "utf8", timeout: 5000 },
  );
  const rates = (res.stdout ?? "")
    .split(/\s+/)
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0);
  return rates.length ? Math.max(...rates) : null;
}

function probeLinux(): number | null {
  // xrandr marks the active mode with '*': e.g. "1920x1080  60.00*+  59.94".
  const res = spawnSync("xrandr", ["--current"], { encoding: "utf8", timeout: 5000 });
  const rates = [...(res.stdout ?? "").matchAll(/([\d.]+)\*/g)].map((m) => Number(m[1]));
  return rates.length ? Math.max(...rates) : null;
}
