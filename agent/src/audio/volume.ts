import { execFile, spawn } from "node:child_process";
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

/**
 * The C# that talks to Windows' audio endpoint, compiled by PowerShell at
 * startup.
 *
 * ## Why this rather than installing something
 *
 * Windows ships no volume command. The obvious answer is to fetch a small tool
 * like nircmd, but downloading and running a third-party binary on the user's
 * machine to move a slider is a poor trade: it is one more thing to trust, to
 * keep current, and to explain to whatever scans their machine.
 *
 * Everything needed is already present. Windows has exposed volume through the
 * Core Audio COM interfaces since Vista, and PowerShell's `Add-Type` compiles
 * C# using the .NET Framework compiler that ships with the OS. So this is a
 * few dozen lines of interop rather than a dependency.
 *
 * ## Why it runs as one long-lived process
 *
 * `Add-Type` compiles on first use, which takes on the order of a second. A
 * volume slider being dragged sends changes continuously, and paying that per
 * change would make the control unusable. The process is started once, holds
 * the compiled type, and reads commands from stdin for the life of the agent.
 *
 * Only three commands are accepted — get, set with a number, mute with 0 or 1 —
 * and the number is clamped before it is written. Nothing from the network is
 * ever concatenated into PowerShell source.
 */
const WINDOWS_VOLUME_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
  int NotImpl1(); int NotImpl2();
  int GetChannelCount(out uint c);
  int SetMasterVolumeLevel(float level, ref Guid ctx);
  int SetMasterVolumeLevelScalar(float level, ref Guid ctx);
  int GetMasterVolumeLevel(out float level);
  int GetMasterVolumeLevelScalar(out float level);
  int SetChannelVolumeLevel(uint ch, float level, ref Guid ctx);
  int SetChannelVolumeLevelScalar(uint ch, float level, ref Guid ctx);
  int GetChannelVolumeLevel(uint ch, out float level);
  int GetChannelVolumeLevelScalar(uint ch, out float level);
  int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid ctx);
  int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
}

[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {
  int Activate(ref Guid id, int ctx, IntPtr act, [MarshalAs(UnmanagedType.IUnknown)] out object o);
}

[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
  int NotImpl1();
  int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice dev);
}

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
class MMDeviceEnumeratorComObject { }

public static class Vol {
  static IAudioEndpointVolume Endpoint() {
    var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
    IMMDevice dev;
    // 0 = eRender (output), 1 = eMultimedia (the volume the user thinks of).
    Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(0, 1, out dev));
    var iid = typeof(IAudioEndpointVolume).GUID;
    object o;
    Marshal.ThrowExceptionForHR(dev.Activate(ref iid, 23, IntPtr.Zero, out o));
    return (IAudioEndpointVolume)o;
  }
  public static float Get() { float v; Marshal.ThrowExceptionForHR(Endpoint().GetMasterVolumeLevelScalar(out v)); return v; }
  public static bool GetMute() { bool m; Marshal.ThrowExceptionForHR(Endpoint().GetMute(out m)); return m; }
  public static void Set(float v) { Guid g = Guid.Empty; Marshal.ThrowExceptionForHR(Endpoint().SetMasterVolumeLevelScalar(v, ref g)); }
  public static void Mute(bool m) { Guid g = Guid.Empty; Marshal.ThrowExceptionForHR(Endpoint().SetMute(m, ref g)); }
}
'@

# One line in, one line out, so the caller can pair replies to requests.
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $parts = $line.Trim().Split(' ')
  try {
    switch ($parts[0]) {
      'get'  { "{0},{1}" -f [int][Math]::Round([Vol]::Get() * 100), ([Vol]::GetMute().ToString().ToLower()) }
      'set'  { [Vol]::Set([double]$parts[1] / 100.0); [Vol]::Mute($false); 'ok' }
      'mute' { [Vol]::Mute($parts[1] -eq '1'); 'ok' }
      default { 'err' }
    }
  } catch { 'err' }
}
`;

/**
 * Only the parts of the helper process this class touches.
 *
 * Declared structurally rather than as ChildProcessWithoutNullStreams because
 * stderr is inherited, which changes the concrete type — and asserting past
 * that would be claiming a stderr stream exists when it does not.
 */
interface VolumeHelperProcess {
  stdin: { write(chunk: string): unknown; end(): unknown };
  stdout: { setEncoding(enc: string): unknown; on(ev: "data", cb: (chunk: string) => void): unknown };
  on(ev: "exit", cb: () => void): unknown;
  kill(): unknown;
}

class WindowsVolumeController implements VolumeController {
  readonly supported = true;
  private proc: VolumeHelperProcess | null = null;
  /** Resolvers for commands awaiting their reply line, in order. */
  private pending: ((line: string) => void)[] = [];
  private stdoutBuf = "";

  constructor(proc: VolumeHelperProcess) {
    this.proc = proc;
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => {
      this.stdoutBuf += chunk;
      let idx: number;
      while ((idx = this.stdoutBuf.indexOf("\n")) >= 0) {
        const line = this.stdoutBuf.slice(0, idx).trim();
        this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
        if (line) this.pending.shift()?.(line);
      }
    });
    proc.on("exit", () => {
      this.proc = null;
      // Anything still waiting will never be answered; fail it rather than
      // leaving the caller's promise pending for the life of the agent.
      for (const resolve of this.pending.splice(0)) resolve("err");
    });
  }

  /** Send one command and wait for its single reply line. */
  private send(command: string): Promise<string> {
    const proc = this.proc;
    if (!proc) return Promise.resolve("err");
    return new Promise<string>((resolve) => {
      const timer = setTimeout(() => {
        // Drop the resolver so a late reply cannot be paired with a later
        // command, which would misreport every result after it.
        const i = this.pending.indexOf(settle);
        if (i >= 0) this.pending.splice(i, 1);
        resolve("err");
      }, 3000);
      const settle = (line: string) => {
        clearTimeout(timer);
        resolve(line);
      };
      this.pending.push(settle);
      proc.stdin.write(`${command}\n`);
    });
  }

  async get(): Promise<OutputVolume | null> {
    const reply = await this.send("get");
    const [rawLevel, rawMuted] = reply.split(",");
    const level = Number(rawLevel);
    if (!Number.isFinite(level)) return null;
    return { level: clampLevel(level), muted: rawMuted?.trim() === "true" };
  }

  async setLevel(level: number): Promise<void> {
    await this.send(`set ${clampLevel(level)}`);
  }

  async setMuted(muted: boolean): Promise<void> {
    await this.send(`mute ${muted ? 1 : 0}`);
  }

  close(): void {
    this.proc?.stdin.end();
    this.proc?.kill();
    this.proc = null;
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
 * Start the Windows helper and confirm it answers before trusting it.
 *
 * The probe matters: `Add-Type` can fail on a locked-down machine — an
 * execution policy that blocks it, a missing compiler, a hardened
 * configuration — and it fails at the first command rather than at spawn. A
 * controller that reports `supported` and then errors on every call is worse
 * than one that admits up front that it cannot work, so support is decided by
 * whether a real reading came back.
 */
async function startWindowsController(): Promise<VolumeController> {
  try {
    const proc = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "-"],
      // stderr is inherited rather than ignored so a compilation failure is
      // visible in the agent's log instead of vanishing; the probe below is
      // what decides support either way.
      { stdio: ["pipe", "pipe", "inherit"], windowsHide: true },
    );
    proc.on("error", () => {});
    proc.stdin.write(`${WINDOWS_VOLUME_SCRIPT}\n`);

    const controller = new WindowsVolumeController(proc);
    const probe = await controller.get();
    if (probe) return controller;
    controller.close();
  } catch {
    // No PowerShell, or it refused to start.
  }
  return new UnsupportedVolumeController();
}

/**
 * Pick a controller for this platform.
 *
 * Every platform uses what the OS already provides — osascript, pactl,
 * PowerShell — so none of this requires the user to install anything. Where
 * that is not possible the controller says so, and the client disables the
 * control rather than showing a slider that silently does nothing.
 */
export async function detectVolumeController(): Promise<VolumeController> {
  if (process.platform === "darwin") return new MacVolumeController();
  if (process.platform === "win32") return startWindowsController();
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

export {
  MacVolumeController,
  PulseVolumeController,
  UnsupportedVolumeController,
  WindowsVolumeController,
  WINDOWS_VOLUME_SCRIPT,
  clampLevel,
};
