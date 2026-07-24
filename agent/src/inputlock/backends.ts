import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { InputLockBackend } from "./index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// agent/{src,dist}/inputlock -> agent/native/bin
const MAC_HELPER = join(__dirname, "..", "..", "native", "bin", "bcsa-inputlock-mac");

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
 *
 * CRITICAL: BlockInput() is subject to UIPI / Mandatory Integrity Control — from
 * a non-elevated (Medium integrity) process it returns FALSE and silently does
 * nothing. So we do NOT assume success: the child reports "READY" on stdout only
 * after BlockInput() actually returned true, and exits non-zero otherwise. lock()
 * waits for that confirmation and rejects if it doesn't come, so the agent never
 * reports a lock that isn't real (a false lock is a security risk — the user
 * would trust a machine that's still open).
 */
class WindowsBlockInputBackend implements InputLockBackend {
  readonly supported = true;
  private child: ChildProcess | null = null;

  async lock(): Promise<void> {
    if (this.child) return;
    const script = [
      "$sig = '[DllImport(\"user32.dll\")] public static extern bool BlockInput(bool f);';",
      "$t = Add-Type -MemberDefinition $sig -Name Native -Namespace Win32 -PassThru;",
      // Only report READY if BlockInput actually engaged; otherwise fail loudly.
      "if ($t::BlockInput($true)) { Write-Output 'READY' }",
      "else { Write-Output 'FAILED'; exit 1 }",
      // Stay alive holding the block until we're killed / stdin closes.
      "while ($true) { Start-Sleep -Seconds 3600 }",
    ].join(" ");

    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
    );
    this.child = child;
    child.on("exit", () => {
      if (this.child === child) this.child = null;
    });

    // Wait for the child to confirm BlockInput succeeded (or fail/timeout).
    await new Promise<void>((resolve, reject) => {
      const fail = (message: string) => {
        clearTimeout(timer);
        if (this.child === child) this.child = null;
        try {
          child.kill();
        } catch {
          /* already gone */
        }
        reject(new Error(message));
      };
      const timer = setTimeout(() => fail("input lock timed out engaging"), 3000);
      child.stdout?.on("data", (d: Buffer) => {
        const out = d.toString();
        if (out.includes("READY")) {
          clearTimeout(timer);
          resolve();
        } else if (out.includes("FAILED")) {
          fail(
            "BlockInput was refused — run the agent as Administrator to lock local input",
          );
        }
      });
      child.on("exit", (code) =>
        fail(
          code === 0
            ? "input lock process exited before engaging"
            : "BlockInput was refused — run the agent as Administrator to lock local input",
        ),
      );
      child.on("error", (err) => fail(String(err)));
    });
  }

  async unlock(): Promise<void> {
    if (!this.child) return;
    // Process exit releases BlockInput; kill is the simplest reliable path.
    this.child.kill();
    this.child = null;
  }
}

/**
 * macOS backend using a compiled Swift helper that installs a CGEventTap. The
 * tap suppresses physical HID input while letting injected (nut-js) events
 * through. The tap lives only while the helper process runs, so killing it — or
 * any crash — instantly restores input. Requires Accessibility permission; if
 * the helper can't create the tap it exits before "READY" and lock() rejects.
 */
class MacEventTapBackend implements InputLockBackend {
  readonly supported: boolean;
  private child: ChildProcess | null = null;

  constructor() {
    // Only advertise support if the helper binary was actually built.
    this.supported = existsSync(MAC_HELPER);
  }

  async lock(): Promise<void> {
    if (this.child) return;
    const child = spawn(MAC_HELPER, [], { stdio: ["ignore", "pipe", "pipe"] });
    this.child = child;
    child.on("exit", () => {
      if (this.child === child) this.child = null;
    });

    // Wait for the helper to confirm the tap is active (or fail).
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("input-lock helper timed out")), 3000);
      child.stdout?.on("data", (d: Buffer) => {
        if (d.toString().includes("READY")) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`input-lock helper exited (${code}); grant Accessibility permission`));
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  async unlock(): Promise<void> {
    if (!this.child) return;
    this.child.kill(); // process exit removes the tap -> input restored
    this.child = null;
  }
}

/** Pick the input-lock backend appropriate for the current OS. */
export function createInputLockBackend(): InputLockBackend {
  switch (platform()) {
    case "win32":
      return new WindowsBlockInputBackend();
    case "darwin":
      return new MacEventTapBackend();
    default:
      // Linux (EVIOCGRAB) not implemented yet; report unsupported honestly.
      return new UnsupportedBackend();
  }
}
