// One-command setup: installs the optional prerequisites the agent uses, via
// whatever package manager the OS already has.
//
//   ffmpeg      -> high-fps screen capture + the WebRTC transport (without it, video is a few fps and WebRTC is off)
//   cloudflared -> optional Cloudflare Tunnel for remote access (npm run tunnel)
//
// Also builds the macOS input-lock helper. Safe to re-run; it skips anything
// already installed. Usage: npm run setup
import { spawnSync } from "node:child_process";
import { platform } from "node:os";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const OS = platform();
/** `npm run setup -- --yes` answers every consent prompt with "yes" (for CI/unattended runs). */
const ASSUME_YES = process.argv.includes("--yes") || process.argv.includes("-y");

function have(cmd, args = ["--version"]) {
  try {
    return spawnSync(cmd, args, { stdio: "ignore", shell: OS === "win32" }).status === 0;
  } catch {
    return false;
  }
}

function run(cmd, args) {
  console.log(`\n$ ${cmd} ${args.join(" ")}`);
  const res = spawnSync(cmd, args, { stdio: "inherit", shell: OS === "win32" });
  return res.status === 0;
}

/**
 * Ask before doing something the user might not want done unattended.
 *
 * Bootstrapping a package manager means downloading a script from the
 * internet and executing it with broad privileges, so it never happens
 * silently: the exact command is printed first and the default is "no".
 * Non-TTY runs (CI, piped stdin) decline rather than hang — pass --yes to
 * opt in there.
 */
async function promptYesNo(question) {
  if (ASSUME_YES) {
    console.log(`${question} → yes (--yes)`);
    return true;
  }
  if (!stdin.isTTY) {
    console.log(`${question} → skipped (not an interactive terminal; re-run with --yes to allow)`);
    return false;
  }
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

/** True when this Windows process can install machine-wide drivers/packages. */
function isWindowsAdmin() {
  if (OS !== "win32") return true;
  try {
    return spawnSync("net", ["session"], { stdio: "ignore", shell: true }).status === 0;
  } catch {
    return false;
  }
}

/** Return the first available package manager for this OS, or null. */
function detectPkgManager() {
  const candidates =
    OS === "darwin"
      ? [["brew", ["--version"]]]
      : OS === "win32"
        ? [
            ["winget", ["--version"]],
            ["choco", ["--version"]],
            ["scoop", ["--version"]],
          ]
        : [
            ["apt-get", ["--version"]],
            ["dnf", ["--version"]],
            ["pacman", ["--version"]],
          ];
  for (const [cmd, args] of candidates) if (have(cmd, args)) return cmd;
  return null;
}

// Official upstream bootstrap commands, verbatim from each project's own docs
// (https://brew.sh and https://docs.chocolatey.org/en-us/choco/setup/). They're
// constants rather than anything assembled at runtime, and both are shown to
// the user before running.
const BREW_BOOTSTRAP =
  'NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"';
const CHOCO_BOOTSTRAP =
  "Set-ExecutionPolicy Bypass -Scope Process -Force; " +
  "[System.Net.ServicePointManager]::SecurityProtocol = 3072; " +
  "iex ((New-Object System.Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1'))";

/**
 * A freshly-installed package manager isn't on this already-running process's
 * PATH, so subsequent installs in the same run would still fail to find it.
 * Add its known install location to our own PATH (the user's next terminal
 * picks it up normally via the shell profile the installer edited).
 */
function addToPath(dir) {
  if (dir && existsSync(dir) && !process.env.PATH?.split(":").includes(dir)) {
    process.env.PATH = `${dir}${OS === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`;
  }
}

async function bootstrapBrew() {
  console.log("\n• Homebrew isn't installed — it's how ffmpeg and BlackHole get installed on macOS.");
  console.log("  This runs Homebrew's official installer, which downloads and executes a script:");
  console.log(`    ${BREW_BOOTSTRAP}`);
  console.log("  (it will ask for your password — installing to /opt/homebrew needs admin rights)");
  if (!(await promptYesNo("  Install Homebrew now?"))) {
    console.log("  Skipped. Install it yourself from https://brew.sh and re-run `npm run setup`.");
    return false;
  }
  const ok = run("/bin/bash", ["-c", BREW_BOOTSTRAP]);
  // Apple Silicon installs to /opt/homebrew, Intel to /usr/local.
  addToPath("/opt/homebrew/bin");
  addToPath("/usr/local/bin");
  if (ok && have("brew")) {
    console.log("✓ Homebrew installed");
    return true;
  }
  console.log("✗ Homebrew install didn't complete — see https://brew.sh");
  return false;
}

async function bootstrapChoco() {
  console.log("\n• Chocolatey isn't installed — it's how VB-Cable gets installed on Windows.");
  console.log("  This runs Chocolatey's official installer, which downloads and executes a script:");
  console.log(`    ${CHOCO_BOOTSTRAP}`);
  if (!isWindowsAdmin()) {
    console.log("  ⚠ This terminal is NOT running as Administrator, which Chocolatey requires.");
    console.log('    Reopen your terminal with "Run as administrator" and re-run `npm run setup`.');
    return false;
  }
  if (!(await promptYesNo("  Install Chocolatey now?"))) {
    console.log("  Skipped. Install it yourself from https://chocolatey.org/install and re-run `npm run setup`.");
    return false;
  }
  const ok = run("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", CHOCO_BOOTSTRAP]);
  addToPath("C:\\ProgramData\\chocolatey\\bin");
  if (ok && have("choco")) {
    console.log("✓ Chocolatey installed");
    return true;
  }
  console.log("✗ Chocolatey install didn't complete — see https://chocolatey.org/install");
  return false;
}

/**
 * Like detectPkgManager(), but offers to install one when the OS has none.
 * Linux is excluded on purpose: apt/dnf/pacman ship with the distro, so a
 * machine without one isn't something a bootstrap script should paper over.
 */
async function ensurePkgManager() {
  const existing = detectPkgManager();
  if (existing) return existing;
  if (OS === "darwin") return (await bootstrapBrew()) ? "brew" : null;
  if (OS === "win32") return (await bootstrapChoco()) ? "choco" : null;
  return null;
}

/** Install commands keyed by (pkgManager, tool). */
const INSTALL = {
  brew: {
    ffmpeg: ["brew", ["install", "ffmpeg"]],
    cloudflared: ["brew", ["install", "cloudflared"]],
  },
  winget: {
    ffmpeg: ["winget", ["install", "-e", "--id", "Gyan.FFmpeg", "--accept-package-agreements", "--accept-source-agreements"]],
    cloudflared: ["winget", ["install", "-e", "--id", "Cloudflare.cloudflared", "--accept-package-agreements", "--accept-source-agreements"]],
  },
  choco: {
    ffmpeg: ["choco", ["install", "ffmpeg", "-y"]],
    cloudflared: ["choco", ["install", "cloudflared", "-y"]],
  },
  scoop: {
    ffmpeg: ["scoop", ["install", "ffmpeg"]],
    cloudflared: ["scoop", ["install", "cloudflared"]],
  },
  "apt-get": {
    ffmpeg: ["sudo", ["apt-get", "install", "-y", "ffmpeg"]],
    cloudflared: null, // not in default apt; see note below
  },
  dnf: {
    ffmpeg: ["sudo", ["dnf", "install", "-y", "ffmpeg"]],
    cloudflared: null,
  },
  pacman: {
    ffmpeg: ["sudo", ["pacman", "-S", "--noconfirm", "ffmpeg"]],
    cloudflared: null,
  },
};

const MANUAL = {
  ffmpeg: "https://ffmpeg.org/download.html",
  cloudflared:
    "https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/",
};

async function ensure(tool, { required }) {
  const probe = tool === "cloudflared" ? ["--version"] : ["-version"];
  if (have(tool, probe)) {
    console.log(`✓ ${tool} already installed`);
    return true;
  }
  console.log(`• ${tool} not found — ${required ? "required for high-fps video + WebRTC" : "optional"}`);
  const pm = await ensurePkgManager();
  const spec = pm && INSTALL[pm]?.[tool];
  if (!spec) {
    console.log(
      `  Couldn't auto-install ${tool} (${pm ? `${pm} has no recipe here` : "no supported package manager found"}).`,
    );
    console.log(`  Install it manually: ${MANUAL[tool]}`);
    return false;
  }
  const ok = run(spec[0], spec[1]);
  if (ok) console.log(`✓ installed ${tool}`);
  else console.log(`✗ failed to install ${tool} — do it manually: ${MANUAL[tool]}`);
  return ok;
}

/**
 * Install a system-audio loopback device so the agent can capture "any playing
 * audio" for transcription. Unlike ffmpeg/cloudflared these are audio drivers
 * with no CLI to probe, so we just run the (idempotent) installer and let the
 * agent detect the device at runtime. Optional — only needed for the client's
 * "Transcribe audio" feature.
 */
async function installLoopback() {
  console.log("\nSystem-audio loopback (optional — for audio transcription):");
  if (OS === "darwin") {
    if (!have("brew") && !(await bootstrapBrew())) {
      console.log("  Install BlackHole manually: https://existential.audio/blackhole/");
      return;
    }
    const ok = run("brew", ["install", "blackhole-2ch"]);
    console.log(
      ok
        ? "✓ BlackHole installed. MANUAL STEP: open Audio MIDI Setup → create a\n" +
            "  Multi-Output Device combining your speakers + BlackHole, and set it as\n" +
            "  the system output, so you both hear audio AND the agent can capture it."
        : "✗ couldn't install BlackHole — get it from https://existential.audio/blackhole/",
    );
  } else if (OS === "win32") {
    // VB-Cable is a signed kernel audio driver and is NOT published on winget,
    // so — unlike ffmpeg/cloudflared, which winget handles fine — Chocolatey is
    // specifically required here. Detecting "some package manager exists" is
    // not enough: a machine with winget but no choco used to fall through to
    // "No Chocolatey found" and give up, even though bootstrapping choco (or
    // downloading the installer) would have worked.
    if (!have("choco") && !(await bootstrapChoco())) {
      console.log("  Install VB-Cable manually: https://vb-audio.com/Cable/");
      console.log("  (unzip, then run VBCABLE_Setup_x64.exe as Administrator)");
      return;
    }
    if (!isWindowsAdmin()) {
      console.log("  ⚠ Installing an audio driver needs Administrator rights.");
      console.log('    Reopen this terminal with "Run as administrator" and re-run `npm run setup`.');
      return;
    }
    const ok = run("choco", ["install", "vb-cable", "-y"]);
    console.log(
      ok
        ? "✓ VB-Cable installed. It may need a reboot / driver-approval before the\n" +
            "  device appears. Set VB-Cable as the playback device (or use \"Listen to\n" +
            '  this device") so audio still reaches your speakers.\n' +
            "  NOTE: restart the agent afterwards — it detects the loopback device once,\n" +
            "  at startup, so a driver installed later isn't picked up until then."
        : "✗ couldn't install VB-Cable — get it from https://vb-audio.com/Cable/",
    );
  } else {
    console.log("  Nothing to install — Linux uses the PulseAudio/PipeWire monitor.");
  }
}

console.log(`Back·Connector setup — OS: ${OS}\n`);

const ffmpegOk = await ensure("ffmpeg", { required: true });
await ensure("cloudflared", { required: false });
await installLoopback();

if (OS === "darwin") {
  console.log("\nBuilding macOS input-lock helper…");
  run("node", ["agent/scripts/build-native.mjs"]);
}

console.log("\n──────────────────────────────────────────────");
console.log(ffmpegOk ? "✓ ffmpeg ready — video mode will run at high fps." : "⚠ ffmpeg missing — video mode will be slow until it's installed.");
if (OS === "win32") {
  console.log("Note: on Windows a freshly-installed tool needs a NEW terminal");
  console.log("for the PATH to update. Close this terminal and reopen before `npm run agent`.");
}
console.log("Next: npm run build  &&  npm run agent");
