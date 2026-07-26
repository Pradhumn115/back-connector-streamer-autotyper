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

const OS = platform();

function have(cmd, args = ["--version"]) {
  try {
    return spawnSync(cmd, args, { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

function run(cmd, args) {
  console.log(`\n$ ${cmd} ${args.join(" ")}`);
  const res = spawnSync(cmd, args, { stdio: "inherit", shell: OS === "win32" });
  return res.status === 0;
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

function ensure(tool, { required }) {
  const probe = tool === "cloudflared" ? ["--version"] : ["-version"];
  if (have(tool, probe)) {
    console.log(`✓ ${tool} already installed`);
    return true;
  }
  console.log(`• ${tool} not found — ${required ? "required for high-fps video + WebRTC" : "optional"}`);
  const pm = detectPkgManager();
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
function installLoopback() {
  console.log("\nSystem-audio loopback (optional — for audio transcription):");
  if (OS === "darwin") {
    const ok = run("brew", ["install", "blackhole-2ch"]);
    console.log(
      ok
        ? "✓ BlackHole installed. MANUAL STEP: open Audio MIDI Setup → create a\n" +
            "  Multi-Output Device combining your speakers + BlackHole, and set it as\n" +
            "  the system output, so you both hear audio AND the agent can capture it."
        : "✗ couldn't install BlackHole — get it from https://existential.audio/blackhole/",
    );
  } else if (OS === "win32") {
    const pm = detectPkgManager();
    if (pm === "choco") {
      const ok = run("choco", ["install", "vb-cable", "-y"]);
      console.log(
        ok
          ? "✓ VB-Cable installed. It may need a reboot / driver-approval before the\n" +
              "  device appears. Set VB-Cable as the playback device (or use \"Listen to\n" +
              "  this device\") so audio still reaches your speakers."
          : "✗ couldn't install VB-Cable — get it from https://vb-audio.com/Cable/",
      );
    } else {
      console.log(
        "  No Chocolatey found. Install VB-Cable manually: https://vb-audio.com/Cable/",
      );
    }
  } else {
    console.log("  Nothing to install — Linux uses the PulseAudio/PipeWire monitor.");
  }
}

console.log(`Back·Connector setup — OS: ${OS}\n`);

const ffmpegOk = ensure("ffmpeg", { required: true });
ensure("cloudflared", { required: false });
installLoopback();

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
