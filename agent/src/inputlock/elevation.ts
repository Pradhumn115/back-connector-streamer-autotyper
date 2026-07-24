import { spawnSync } from "node:child_process";
import { platform } from "node:os";

export interface ElevationProbe {
  platform: NodeJS.Platform;
  /** Exit status of the `net session` probe (null if the process was signalled). */
  status: number | null;
  /** True if the probe couldn't be spawned at all. */
  error: boolean;
}

/**
 * Decide whether the agent is elevated from a `net session` probe result. Pure
 * so it can be tested off-Windows.
 *
 * - Non-Windows: elevation is irrelevant to the input lock (macOS uses an
 *   Accessibility-permitted helper, Linux is unsupported), so report `true` and
 *   never warn.
 * - Windows: `net session` exits 0 only for an elevated (admin) process; a
 *   non-zero exit means "Access is denied" → not elevated.
 * - If the probe couldn't run at all, we can't tell, so assume elevated rather
 *   than nag the user with a possibly-spurious warning.
 */
export function decideElevation(p: ElevationProbe): boolean {
  if (p.platform !== "win32") return true;
  if (p.error) return true;
  return p.status === 0;
}

/**
 * True if this process can actually block system input. On Windows that means
 * running elevated (see `WindowsBlockInputBackend`); everywhere else it's always
 * true because elevation isn't the gating factor there.
 */
export function isElevated(): boolean {
  if (platform() !== "win32") return true;
  // `net session` requires admin; its exit code tells us elevation status
  // without side effects. windowsHide avoids flashing a console window.
  const probe = spawnSync("net", ["session"], {
    stdio: "ignore",
    windowsHide: true,
  });
  return decideElevation({
    platform: "win32",
    status: probe.status,
    error: Boolean(probe.error),
  });
}
