#!/usr/bin/env node
// Back·Connector launcher — one file to set everything up and pick what to run.
//
//   node launch.mjs      (or: npm start)
//
// Shows a menu: full setup, run the agent, run the client, run the tunnel,
// rebuild, or a local agent+client test. Dependency-free and cross-platform.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
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

/**
 * Newest modification time under a directory, or 0 if it doesn't exist.
 *
 * Used to compare sources against build output. `existsSync` alone cannot tell
 * a current build from a stale one, and a stale build is the normal state after
 * `git pull` — the directory is right there, just out of date.
 */
function newestMtime(dir, exts) {
  let newest = 0;
  const walk = (d) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return; // unreadable or missing; treat as "nothing here"
    }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (exts.some((x) => e.name.endsWith(x))) {
        try {
          newest = Math.max(newest, statSync(full).mtimeMs);
        } catch {
          // Raced with a delete; ignore.
        }
      }
    }
  };
  walk(dir);
  return newest;
}

/** Workspaces to check for missing dependencies. */
const WORKSPACES = ["shared", "agent", "client"];

/**
 * True when `shared`'s sources are newer than its compiled output.
 *
 * Only `shared` is checked, because only `shared` is consumed as BUILD OUTPUT
 * at runtime: its package.json points at `dist/`, and both the agent and the
 * client import it that way. The agent itself runs from source via tsx, and the
 * client is served from source by Vite in dev, so their `dist/` directories
 * being stale changes nothing about what actually executes — flagging them
 * would mean a rebuild after every source edit for no benefit.
 *
 * Getting this wrong is quiet rather than loud. A protocol change that is not
 * rebuilt leaves new enum members `undefined`, so frames are labelled 0 (JPEG)
 * instead of 2 (H264) and the client tries to render video as an image: a blank
 * screen that looks like a rendering bug rather than a build problem.
 */
function buildIsStale() {
  const src = join(ROOT, "shared", "src");
  const dist = join(ROOT, "shared", "dist");
  if (!existsSync(src)) return false;
  if (!existsSync(dist)) return true;
  return newestMtime(src, [".ts", ".tsx"]) > newestMtime(dist, [".js", ".d.ts"]);
}

/**
 * Dependencies declared in a workspace but absent from node_modules.
 *
 * A pull that adds a dependency leaves node_modules present but incomplete, so
 * an existence check on the directory passes while the import still fails at
 * runtime with a bare "Cannot find module".
 */
function missingDependencies() {
  const missing = [];
  for (const pkg of ["", ...WORKSPACES]) {
    const manifest = join(ROOT, pkg, "package.json");
    if (!existsSync(manifest)) continue;
    let deps;
    try {
      deps = JSON.parse(readFileSync(manifest, "utf8")).dependencies ?? {};
    } catch {
      continue;
    }
    for (const name of Object.keys(deps)) {
      // Workspace siblings are symlinked by npm and may resolve from the root.
      if (name.startsWith("@bcsa/")) continue;
      if (
        !existsSync(join(ROOT, "node_modules", name)) &&
        !existsSync(join(ROOT, pkg, "node_modules", name))
      ) {
        missing.push(name);
      }
    }
  }
  return [...new Set(missing)];
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
  const missing = missingDependencies();
  const deps = existsSync(join(ROOT, "node_modules")) && missing.length === 0;
  const built = existsSync(join(ROOT, "shared", "dist")) && !buildIsStale();
  const ffmpeg = have("ffmpeg", ["-version"]);
  const cloudflared = have("cloudflared");
  const mark = (ok) => (ok ? color("green", "✓") : color("red", "•"));
  console.log(color("bold", "\n  Back·Connector\n"));
  console.log(
    `  ${mark(deps)} dependencies installed` +
      (missing.length ? color("dim", ` (missing: ${missing.slice(0, 3).join(", ")})`) : ""),
  );
  console.log(
    `  ${mark(built)} packages built ${built ? "" : color("dim", "(sources changed since last build)")}`,
  );
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
  // Staleness, not mere existence. After a `git pull` every path below exists
  // and is out of date, which is precisely when running stale code does the
  // most damage and explains the least.
  const needInstall = !existsSync(join(ROOT, "node_modules")) || missingDependencies().length > 0;
  const needFfmpeg = !have("ffmpeg", ["-version"]);
  const needBuild = buildIsStale();

  if (!needInstall && !needFfmpeg && !needBuild) return; // nothing to do

  console.log(color("amber", "\n  Setting up automatically (dependencies or build are out of date)…"));
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
