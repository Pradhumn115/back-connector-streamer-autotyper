// One-command setup: installs the optional prerequisites the agent uses, via
// whatever package manager the OS already has.
//
//   ffmpeg      -> high-fps screen capture (without it, video mode is a few fps)
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
  console.log(`• ${tool} not found — ${required ? "required for high fps" : "optional"}`);
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

console.log(`Back·Connector setup — OS: ${OS}\n`);

const ffmpegOk = ensure("ffmpeg", { required: true });
ensure("cloudflared", { required: false });

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
