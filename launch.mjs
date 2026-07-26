#!/usr/bin/env node
// Back·Connector launcher — one file to set everything up and pick what to run.
//
//   node launch.mjs      (or: npm start)
//
// Shows a menu: full setup, run the agent, run the client, run the tunnel,
// rebuild, or a local agent+client test. Dependency-free and cross-platform.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const IS_WIN = platform() === "win32";

const C = {
  reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m",
  amber: "\x1b[38;5;214m", green: "\x1b[38;5;42m", red: "\x1b[38;5;203m", cyan: "\x1b[38;5;80m",
};
const color = (c, s) => `${C[c]}${s}${C.reset}`;

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((res) => rl.question(q, res));

/** Is a CLI tool on PATH? */
function have(cmd, args = ["--version"]) {
  try {
    return spawnSync(cmd, args, { stdio: "ignore", shell: IS_WIN }).status === 0;
  } catch {
    return false;
  }
}

/** Run a command inheriting the terminal. Ctrl-C stops the child, not the menu. */
function run(cmd, args) {
  return new Promise((resolve) => {
    console.log(color("dim", `\n$ ${cmd} ${args.join(" ")}\n`));
    const child = spawn(cmd, args, { stdio: "inherit", cwd: ROOT, shell: IS_WIN });
    const swallow = () => {}; // keep the launcher alive while the child runs
    process.on("SIGINT", swallow);
    child.on("close", (code) => {
      process.removeListener("SIGINT", swallow);
      resolve(code ?? 0);
    });
    child.on("error", (err) => {
      process.removeListener("SIGINT", swallow);
      console.log(color("red", `  failed to start: ${err.message}`));
      resolve(1);
    });
  });
}

const npm = (script) => run("npm", ["run", script]);

/** One line per prerequisite so the user sees what's ready. */
function printStatus() {
  const deps = existsSync(join(ROOT, "node_modules"));
  const built = existsSync(join(ROOT, "shared", "dist"));
  const ffmpeg = have("ffmpeg", ["-version"]);
  const cloudflared = have("cloudflared");
  const mark = (ok) => (ok ? color("green", "✓") : color("red", "•"));
  console.log(color("bold", "\n  Back·Connector\n"));
  console.log(`  ${mark(deps)} dependencies installed`);
  console.log(`  ${mark(built)} packages built ${built ? "" : color("dim", "(needed before agent/client)")}`);
  console.log(`  ${mark(ffmpeg)} ffmpeg ${ffmpeg ? "" : color("dim", "(needed for high-fps video + WebRTC)")}`);
  console.log(`  ${mark(cloudflared)} cloudflared ${cloudflared ? "" : color("dim", "(optional — for tunnel)")}`);
  return { deps, built };
}

async function fullSetup() {
  if (!existsSync(join(ROOT, "node_modules"))) await run("npm", ["install"]);
  await npm("setup");
  await npm("build");
  console.log(color("green", "\n✓ Setup complete.\n"));
}

/**
 * Run only the setup steps whose outputs are missing, so a fresh clone becomes
 * runnable automatically. Skips entirely when everything is already in place.
 */
async function autoBootstrap() {
  const needInstall = !existsSync(join(ROOT, "node_modules"));
  const needFfmpeg = !have("ffmpeg", ["-version"]);
  const needBuild = !existsSync(join(ROOT, "shared", "dist"));

  if (!needInstall && !needFfmpeg && !needBuild) return; // nothing to do

  console.log(color("amber", "\n  Some prerequisites are missing — setting up automatically…"));
  if (needInstall) await run("npm", ["install"]);
  // ffmpeg missing ⇒ likely an unconfigured machine: run the full prerequisite
  // installer (ffmpeg + optional cloudflared/audio + macOS native helper).
  if (needFfmpeg) await npm("setup");
  if (needInstall || needBuild) await npm("build");
  console.log(color("green", "\n✓ Ready.\n"));
}

/** Local test: agent in the background + client in the foreground. */
async function localTest() {
  console.log(color("cyan", "\nStarting the agent in the background, then the client…"));
  const agent = spawn("npm", ["run", "agent"], { stdio: "inherit", cwd: ROOT, shell: IS_WIN });
  await new Promise((r) => setTimeout(r, 3000)); // let the agent print its banner
  await npm("client"); // foreground; Ctrl-C returns here
  agent.kill();
}

const MENU = `
  ${color("bold", "What do you want to run?")}

  ${color("amber", "1")}  Full setup        install deps + prerequisites + build ${color("dim", "(run first)")}
  ${color("amber", "2")}  Run agent         ${color("dim", "this machine gets controlled + streamed")}
  ${color("amber", "3")}  Run client        ${color("dim", "control another machine from your browser")}
  ${color("amber", "4")}  Run tunnel        ${color("dim", "expose the agent over Cloudflare (remote)")}
  ${color("amber", "5")}  Rebuild           ${color("dim", "recompile all packages")}
  ${color("amber", "6")}  Local test        ${color("dim", "agent + client on this machine")}
  ${color("amber", "q")}  Quit
`;

async function main() {
  await autoBootstrap(); // install/build/prereqs if anything essential is missing
  printStatus();
  for (;;) {
    console.log(MENU);
    const choice = (await ask(color("amber", "  › "))).trim().toLowerCase();
    switch (choice) {
      case "1": await fullSetup(); break;
      case "2": await npm("agent"); break;
      case "3": await npm("client"); break;
      case "4": await npm("tunnel"); break;
      case "5": await npm("build"); break;
      case "6": await localTest(); break;
      case "q": case "quit": case "exit":
        rl.close();
        return;
      default:
        console.log(color("red", "  Pick 1–6 or q."));
    }
  }
}

main().then(() => process.exit(0));
