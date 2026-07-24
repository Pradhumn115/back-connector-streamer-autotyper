/**
 * Optional global hotkey (Ctrl+Alt+L by default) that toggles the input lock
 * from the agent side. Uses uiohook-napi for OS-wide key capture. The whole
 * thing is best-effort: if the native module isn't installed or fails to load,
 * we log once and continue without a hotkey — it must never take down the agent.
 *
 * Note: when the lock uses a full block (Windows BlockInput), physical keys are
 * suppressed, so the hotkey can turn the lock ON but not OFF. Turning it off is
 * handled by the client and the auto-release watchdog (see InputLockManager).
 */
export interface HotkeyHandle {
  stop(): void;
}

export async function registerLockHotkey(onToggle: () => void): Promise<HotkeyHandle> {
  try {
    const mod = await import("uiohook-napi");
    const { uIOhook, UiohookKey } = mod;

    const onKeydown = (e: { keycode: number; ctrlKey: boolean; altKey: boolean }) => {
      if (e.ctrlKey && e.altKey && e.keycode === UiohookKey.L) onToggle();
    };
    uIOhook.on("keydown", onKeydown);
    uIOhook.start();
    process.stdout.write("Input-lock hotkey ready: Ctrl+Alt+L\n");

    return {
      stop() {
        try {
          uIOhook.off("keydown", onKeydown);
          uIOhook.stop();
        } catch {
          /* ignore */
        }
      },
    };
  } catch (err) {
    process.stderr.write(
      `[inputlock] global hotkey unavailable (${String(err)}); use the client toggle instead.\n`,
    );
    return { stop() {} };
  }
}
