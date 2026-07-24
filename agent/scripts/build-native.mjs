// Builds the macOS input-lock helper (Swift -> native binary) when possible.
// No-ops on non-macOS or when the Swift toolchain isn't present, so it's safe
// to run from `postinstall` and the cross-platform build without failing.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { platform } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const nativeDir = join(here, "..", "native");
const src = join(nativeDir, "inputlock-mac.swift");
const outDir = join(nativeDir, "bin");
const out = join(outDir, "bcsa-inputlock-mac");

if (platform() !== "darwin") {
  console.log("[build-native] not macOS; skipping input-lock helper.");
  process.exit(0);
}
if (spawnSync("swiftc", ["--version"], { stdio: "ignore" }).status !== 0) {
  console.log("[build-native] swiftc not found; input-lock will report unsupported on macOS.");
  process.exit(0);
}
if (!existsSync(src)) {
  console.log("[build-native] source missing; skipping.");
  process.exit(0);
}

mkdirSync(outDir, { recursive: true });
try {
  execFileSync("swiftc", ["-O", "-o", out, src], { stdio: "inherit" });
  console.log(`[build-native] built ${out}`);
} catch (err) {
  console.log(`[build-native] compile failed (${String(err)}); macOS lock will be unsupported.`);
}
