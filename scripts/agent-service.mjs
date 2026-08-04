// 007 James Bond — installs the agent as a per-user, login-triggered OS
// service (launchd on macOS, systemd --user on Linux, Task Scheduler on
// Windows) so it survives a reboot and restarts itself if it crashes.
//
// Deliberately login-triggered, not boot-triggered: screen capture only
// works inside a real logged-in graphical session, so a true boot-time
// service (root LaunchDaemon / system systemd unit / SYSTEM-level Windows
// Service) would need admin/sudo to install and still produce a blank
// capture until someone actually logs in. A per-user login service needs
// no elevated privileges and runs in a session where capture permissions
// apply normally.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";

const IS_WIN = platform() === "win32";
const IS_MAC = platform() === "darwin";
const IS_LINUX = platform() === "linux";

const MAC_LABEL = "dev.beamdesk.agent";
const LINUX_UNIT = "beamdesk-agent.service";
const WIN_TASK = "BeamdeskAgent";

/**
 * Absolute path to the npm executable.
 *
 * Service managers give the launched process a minimal environment — a
 * GUI login session's PATH under launchd, for instance, typically doesn't
 * include a Homebrew- or nvm-installed npm. Baking in the absolute path
 * (resolved here, in a process that inherited the user's real shell PATH)
 * avoids "npm: command not found" once the service manager takes over.
 */
function resolveNpmPath() {
  const finder = IS_WIN ? "where" : "which";
  const result = spawnSync(finder, ["npm"], { encoding: "utf8" });
  const path = result.stdout?.split(/\r?\n/).find((line) => line.trim())?.trim();
  if (!path) {
    throw new Error(`Could not resolve the npm executable path (${finder} npm found nothing).`);
  }
  return path;
}

/**
 * A minimal-but-sufficient PATH for the service to run npm's own shebang
 * (`#!/usr/bin/env node`) and find tools like ffmpeg.
 *
 * launchd/systemd give login services a much smaller PATH than an
 * interactive shell — confirmed by testing: without this, the plist above
 * installed and "ran" but immediately failed with `env: node: No such file
 * or directory`, because launchd's default PATH doesn't include Homebrew's
 * bin directory. Baking in npm's own directory plus the standard Homebrew/
 * system locations (rather than the full inherited PATH, which on a dev
 * machine can be stuffed with unrelated tool-specific entries) keeps the
 * generated service file minimal and portable.
 */
function buildServicePath(npmPath) {
  const dirs = [dirname(npmPath), "/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  return [...new Set(dirs)].join(":");
}

function run(cmd, args) {
  return spawnSync(cmd, args, { encoding: "utf8" });
}

// ---------------------------------------------------------------------------
// macOS — launchd LaunchAgent
// ---------------------------------------------------------------------------

function macPlistPath() {
  return join(homedir(), "Library", "LaunchAgents", `${MAC_LABEL}.plist`);
}

function macPlist({ root, logFile, npmPath }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${MAC_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${npmPath}</string>
    <string>run</string>
    <string>agent</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${root}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${buildServicePath(npmPath)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${logFile}</string>
  <key>StandardErrorPath</key>
  <string>${logFile}</string>
</dict>
</plist>
`;
}

function installMac({ root, logFile }) {
  const plistPath = macPlistPath();
  mkdirSync(dirname(plistPath), { recursive: true });
  writeFileSync(plistPath, macPlist({ root, logFile, npmPath: resolveNpmPath() }));
  const load = run("launchctl", ["load", "-w", plistPath]);
  if (load.status !== 0) {
    throw new Error(`launchctl load failed: ${load.stderr || load.stdout}`);
  }
  run("launchctl", ["start", MAC_LABEL]); // kick off now rather than waiting for next login
}

function uninstallMac() {
  const plistPath = macPlistPath();
  if (existsSync(plistPath)) {
    run("launchctl", ["unload", "-w", plistPath]);
    unlinkSync(plistPath);
  }
}

function statusMac() {
  const plistPath = macPlistPath();
  const installed = existsSync(plistPath);
  if (!installed) return { installed: false, running: false };
  const list = run("launchctl", ["list", MAC_LABEL]);
  if (list.status !== 0) return { installed: true, running: false };
  const match = list.stdout.match(/"PID"\s*=\s*(\d+)/);
  return match ? { installed: true, running: true, pid: Number(match[1]) } : { installed: true, running: false };
}

// ---------------------------------------------------------------------------
// Linux — systemd --user
// ---------------------------------------------------------------------------

function linuxUnitPath() {
  return join(homedir(), ".config", "systemd", "user", LINUX_UNIT);
}

function linuxUnit({ root, logFile, npmPath }) {
  return `[Unit]
Description=Beamdesk agent

[Service]
Type=simple
WorkingDirectory=${root}
Environment=PATH=${buildServicePath(npmPath)}
ExecStart=${npmPath} run agent
Restart=on-failure
RestartSec=5
StandardOutput=append:${logFile}
StandardError=append:${logFile}

[Install]
WantedBy=default.target
`;
}

function installLinux({ root, logFile }) {
  if (run("systemctl", ["--version"]).error) {
    throw new Error("systemd not found — 007 requires systemd on Linux.");
  }
  const unitPath = linuxUnitPath();
  mkdirSync(dirname(unitPath), { recursive: true });
  writeFileSync(unitPath, linuxUnit({ root, logFile, npmPath: resolveNpmPath() }));
  run("systemctl", ["--user", "daemon-reload"]);
  const enable = run("systemctl", ["--user", "enable", "--now", LINUX_UNIT]);
  if (enable.status !== 0) {
    throw new Error(`systemctl --user enable failed: ${enable.stderr || enable.stdout}`);
  }
}

function uninstallLinux() {
  const unitPath = linuxUnitPath();
  if (existsSync(unitPath)) {
    run("systemctl", ["--user", "disable", "--now", LINUX_UNIT]);
    unlinkSync(unitPath);
    run("systemctl", ["--user", "daemon-reload"]);
  }
}

function statusLinux() {
  const unitPath = linuxUnitPath();
  const installed = existsSync(unitPath);
  if (!installed) return { installed: false, running: false };
  const active = run("systemctl", ["--user", "is-active", LINUX_UNIT]);
  const running = active.stdout?.trim() === "active";
  if (!running) return { installed: true, running: false };
  const pidResult = run("systemctl", ["--user", "show", LINUX_UNIT, "--property=MainPID", "--value"]);
  const pid = Number(pidResult.stdout?.trim());
  return pid > 0 ? { installed: true, running: true, pid } : { installed: true, running: true };
}

// ---------------------------------------------------------------------------
// Windows — Task Scheduler
// ---------------------------------------------------------------------------

function winTaskXml({ root, logFile }) {
  const command = `/c "npm run agent >> "${logFile}" 2>&1"`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Beamdesk agent - starts on login, restarts on crash</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>cmd.exe</Command>
      <Arguments>${command.replace(/&/g, "&amp;")}</Arguments>
      <WorkingDirectory>${root}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

function installWindows({ root, logFile }) {
  resolveNpmPath(); // fail fast with a clear error if npm can't be found, even though the task shells out to it by name
  const xmlPath = join(root, "agent", ".data", "beamdesk-task.xml");
  mkdirSync(dirname(xmlPath), { recursive: true });
  writeFileSync(xmlPath, winTaskXml({ root, logFile }), "utf8");
  const create = run("schtasks", ["/Create", "/TN", WIN_TASK, "/XML", xmlPath, "/F"]);
  unlinkSync(xmlPath);
  if (create.status !== 0) {
    throw new Error(`schtasks /Create failed: ${create.stderr || create.stdout}`);
  }
  run("schtasks", ["/Run", "/TN", WIN_TASK]); // kick off now rather than waiting for next login
}

function uninstallWindows() {
  run("schtasks", ["/Delete", "/TN", WIN_TASK, "/F"]);
}

function statusWindows() {
  const query = run("schtasks", ["/Query", "/TN", WIN_TASK, "/FO", "LIST", "/V"]);
  if (query.status !== 0) return { installed: false, running: false };
  const running = /^Status:\s*Running/m.test(query.stdout || "");
  return { installed: true, running };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function installService(ctx) {
  if (IS_MAC) return installMac(ctx);
  if (IS_LINUX) return installLinux(ctx);
  if (IS_WIN) return installWindows(ctx);
  throw new Error(`Unsupported platform: ${platform()}`);
}

export function uninstallService() {
  if (IS_MAC) return uninstallMac();
  if (IS_LINUX) return uninstallLinux();
  if (IS_WIN) return uninstallWindows();
  throw new Error(`Unsupported platform: ${platform()}`);
}

export function serviceStatus() {
  if (IS_MAC) return statusMac();
  if (IS_LINUX) return statusLinux();
  if (IS_WIN) return statusWindows();
  throw new Error(`Unsupported platform: ${platform()}`);
}
