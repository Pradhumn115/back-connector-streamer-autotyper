import { spawn, type ChildProcess } from "node:child_process";
import { platform } from "node:os";
import type { InputLockBackend } from "./index.js";

/**
 * A backend for OSes where blocking isn't implemented yet. It reports
 * supported=false so the client disables the control and never shows a false
 * "locked" state (a lock the user believes is on but isn't would be a security
 * risk, e.g. walking away from an "unlocked" machine).
 */
class UnsupportedBackend implements InputLockBackend {
  readonly supported = false;
  async lock(): Promise<void> {
    throw new Error("input lock not supported on this agent OS yet");
  }
  async unlock(): Promise<void> {
    /* nothing to release */
  }
}

/**
 * Windows backend using the Win32 BlockInput() API via a persistent PowerShell
 * process. BlockInput(TRUE) blocks physical keyboard/mouse while our synthetic
 * events (SendInput via nut-js) still get through. The block is held for as long
 * as the child process lives and is released the instant it exits — so killing
 * the child (or the agent crashing) restores input automatically. That
 * auto-restore-on-exit is itself a safety failsafe. Note: Ctrl+Alt+Del always
 * bypasses BlockInput (a Windows guarantee), giving the local user a final way
 * out.
 */
class WindowsBlockInputBackend implements InputLockBackend {
  readonly supported = true;
  private child: ChildProcess | null = null;

  async lock(): Promise<void> {
    if (this.child) return;
    const script = [
      "$sig = '[DllImport(\"user32.dll\")] public static extern bool BlockInput(bool f);';",
      "$t = Add-Type -MemberDefinition $sig -Name Native -Namespace Win32 -PassThru;",
      "[void]$t::BlockInput($true);",
      // Stay alive holding the block until we're killed / stdin closes.
      "while ($true) { Start-Sleep -Seconds 3600 }",
    ].join(" ");

    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { stdio: "ignore", windowsHide: true },
    );
    child.on("error", () => {
      this.child = null;
    });
    child.on("exit", () => {
      if (this.child === child) this.child = null;
    });
    this.child = child;
  }

  async unlock(): Promise<void> {
    if (!this.child) return;
    // Process exit releases BlockInput; kill is the simplest reliable path.
    this.child.kill();
    this.child = null;
  }
}

/** Pick the input-lock backend appropriate for the current OS. */
export function createInputLockBackend(): InputLockBackend {
  if (platform() === "win32") return new WindowsBlockInputBackend();
  // macOS (CGEventTap) and Linux (EVIOCGRAB) require a native addon; not yet
  // implemented, so we honestly report unsupported.
  return new UnsupportedBackend();
}
