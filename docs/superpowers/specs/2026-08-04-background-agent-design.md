# Background agent mode

## Problem

`npm start` (`launch.mjs`) offers "Run agent" as a foreground process (`stdio: "inherit"`). Closing the terminal kills it. The agent is the process that runs unattended on the machine being controlled/streamed, so it needs a way to keep running after the terminal closes.

## Scope

Only the **agent** gets a background mode. Client, tunnel, and other menu options are unaffected.

## Design

### Runtime state

- `agent/.data/agent.pid` — PID of the detached agent process.
- `agent/.data/agent.log` — combined stdout/stderr of the detached agent.

`agent/.data/` is already gitignored (see `.gitignore`), so no new ignore rule is needed.

### New functions in `launch.mjs`

- **`startAgentBackground()`**
  - Checks liveness first (see below). If already running, prints `already running (pid N), see agent/.data/agent.log` and does nothing.
  - Otherwise spawns `npm run agent` in the background via a platform-specific helper (see below), writes the returned PID to the PID file, prints confirmation with the log path.
- **`spawnDetachedPosix()`** (macOS/Linux) — `spawn("npm", ["run", "agent"], { detached: true, stdio: [...file] })` + `.unref()`.
- **`spawnHiddenWindows()`** (Windows) — see "Windows console-window fix" below. `detached: true` + `windowsHide: true` on Windows pops a real console window for this process tree (confirmed: nodejs/node#21825, #36808 — `detached` forces the child to get its own console on Windows, and `windowsHide` doesn't reliably suppress that once stdio is redirected to real file handles rather than `"ignore"`). Instead, launches via `powershell.exe -Command "Start-Process -FilePath cmd.exe -ArgumentList '/c','cd /d ROOT && npm run agent >> LOG 2>&1' -WindowStyle Hidden -PassThru"`, which genuinely hides the window and returns the real PID via `-PassThru` so `stopAgentBackground`'s `taskkill /T /F` can still kill the whole tree.
- **`agentStatus()`**
  - Reads the PID file. If absent, reports "not running."
  - If present, checks liveness with `process.kill(pid, 0)` (throws `ESRCH` if the process doesn't exist — works cross-platform in Node, including Windows).
  - If dead, reports "not running (stale pid file removed)" and deletes the PID file.
  - If alive, reports "running (pid N)" and the log file path.
  - Also reports the 007 login-service state (installed? running? pid if known) — see below.
- **`stopAgentBackground()`**
  - Reads the PID file. If absent, reports "not running."
  - If present and alive, kills the whole process tree (see "process-tree kill" below) and deletes the PID file, reports "stopped."
  - If present and dead, reports "not running (stale pid file removed)" and deletes the PID file.

### Menu

```
1  Full setup
2  Run agent               (refuses if 007 is active — see conflict handling)
3  Run agent (background)  (same)
4  Agent status             reports BOTH plain background and 007 state
5  Stop background agent
6  007 James Bond           install + start login-autostart, survives reboot, restarts on crash
7  M (retire 007)           stop + uninstall the login-autostart service
8  Run client
9  Run tunnel
10 Rebuild
11 Local test
q  Quit
```

## Process-tree kill (all platforms)

`npm run agent` is 4 processes deep (`npm` → `npm run start` → `tsx` loader → the real `node` process), and npm does not forward `SIGTERM` to its children — signaling only the tracked PID leaves the real agent running and the port held (confirmed by hitting this live during testing: a client connected fine, but "stop" left the agent still listening on 8443 with orphaned processes).

- **macOS/Linux**: `detached: true` makes the tracked PID a process-group leader, so `process.kill(-pid)` (negative PID = signal the whole group) reaches every descendant.
- **Windows**: no process groups; `taskkill /pid <pid> /T /F` walks the process tree instead.

## Windows console-window fix

Separately from the process-tree issue: the initial Windows background implementation used `spawn(..., { detached: true, windowsHide: true, stdio: [...file] })`, matching the macOS/Linux code path. On Windows this popped a visible console window despite `windowsHide` — a confirmed Node.js limitation (nodejs/node#21825, #36808): `detached: true` forces the child onto its own console on Windows, and `windowsHide` does not reliably suppress that once stdio is redirected to real file handles instead of `"ignore"`.

Fix: Windows now launches via PowerShell's `Start-Process -WindowStyle Hidden -PassThru`, which genuinely hides the window (this is the standard, dependency-free technique for this on Windows — PowerShell ships with every Windows install) and returns the real PID via `-PassThru`, preserving the `taskkill /T` stop path. Redirection to the shared log file is done by `cmd.exe`'s own `>>`/`2>&1` inside the command string, not PowerShell's `-RedirectStandardOutput`/`-RedirectStandardError`, because those two parameters require distinct file paths and we want one shared log across platforms.

## 007 James Bond: OS-level login-autostart service

### Scope decision: login-triggered, not boot-triggered

Screen capture (ScreenCaptureKit on macOS, and the equivalent on Windows/Linux) only works inside a real logged-in graphical session. A true boot-time service (macOS `LaunchDaemon` as root, Linux system-wide systemd unit, Windows Service running as SYSTEM) runs before/outside any GUI session, so screen capture would fail or stay blank until a user actually logs in — and it needs admin/sudo to install. 007 instead registers a **per-user, login-triggered** autostart, which needs no elevated privileges and runs in a real user session where screen capture permissions apply normally.

### New file: `scripts/agent-service.mjs`

Matches the existing convention (`scripts/setup.mjs`, `scripts/tunnel.mjs` are standalone `.mjs` utilities). Exports three functions, each dispatching on `os.platform()`:

- **`installService({ root, logFile })`** — registers + starts the login-autostart service. Resolves the `npm` executable's absolute path first (via `which npm` / `where npm`) and bakes it into the service definition — GUI login sessions on macOS and some systemd/Task Scheduler contexts have a minimal `PATH` that may not include a Homebrew/nvm-installed `npm`, so relying on `PATH` resolution inside the service definition is unreliable.
- **`uninstallService({ root, logFile })`** — stops and deregisters the service, removes its definition file.
- **`serviceStatus({ root, logFile })`** — returns `{ installed, running, pid? }`.

### Per-platform mechanics

**macOS (launchd)**
- `~/Library/LaunchAgents/dev.beamdesk.agent.plist` — a `LaunchAgent` (per-user), not a `LaunchDaemon`.
- `RunAtLoad: true` — starts at login.
- `KeepAlive: { SuccessfulExit: false }` — restarts only on crash (nonzero exit), not after an intentional stop (exit 0). Confirmed via Apple's own docs: this is the standard "restart on crash only" idiom.
- `StandardOutPath` / `StandardErrorPath` → the shared `agent/.data/agent.log`.
- Install: write the plist, `launchctl load -w <plist>`, then `launchctl start dev.beamdesk.agent` to start it immediately rather than waiting for the next login.
- Uninstall: `launchctl unload -w <plist>`, delete the plist.
- Status: `launchctl list dev.beamdesk.agent` — exit 0 and a `"PID" = N;` line means running; nonzero means not loaded/running. `installed` is just "does the plist file exist."

**Linux (systemd --user)**
- `~/.config/systemd/user/beamdesk-agent.service`.
- `Restart=on-failure`, `RestartSec=5`.
- `WantedBy=default.target` — confirmed via systemd docs this (not `graphical-session.target`, which is a virtual target other units alias into and cannot be enabled against directly) is the correct target for "start when the user session begins."
- `StandardOutput=append:<log>`, `StandardError=append:<log>` → the shared log file.
- Install: write the unit, `systemctl --user daemon-reload`, `systemctl --user enable --now beamdesk-agent.service`.
- Uninstall: `systemctl --user disable --now beamdesk-agent.service`, delete the unit file, `daemon-reload`.
- Status: `systemctl --user is-active` (running?) + unit file existence (installed?); PID via `systemctl --user show --property=MainPID --value`.
- If `systemctl` isn't on `PATH` (systemd-less distros), `installService` throws a clear "systemd not found" error instead of crashing.

**Windows (Task Scheduler)**
- A scheduled task named `BeamdeskAgent`, created from a generated XML definition (needed because plain `schtasks /Create` flags don't expose crash-restart; the XML form's `<Settings><RestartOnFailure>` does).
- `<LogonTrigger>` — starts at login, current user, no elevation required.
- `<RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure>`.
- Action: `cmd.exe /c "npm run agent >> <log> 2>&1"`, working directory = project root.
- Install: `schtasks /Create /TN BeamdeskAgent /XML <path> /F`, then `schtasks /Run /TN BeamdeskAgent` to start immediately.
- Uninstall: `schtasks /Delete /TN BeamdeskAgent /F`.
- Status: `schtasks /Query /TN BeamdeskAgent /FO LIST /V` — nonzero exit means not installed; parse the `Status:` field for `Running`. Task Scheduler doesn't expose a PID cleanly via `schtasks`, so `pid` is omitted on Windows status.
- Task Scheduler tasks run without a console window by default, so the console-window fix above doesn't apply here.

### Conflict handling

Both the plain background mode and the 007 service bind port 8443, so only one may run at a time (this exact class of crash — `EADDRINUSE` — was hit live during testing of the plain background mode).

- `installService()` stops a running plain-background instance first (`stopAgentBackground()`), then installs+starts 007.
- Starting the agent via option 2 (foreground) or option 3 (background) while 007 is active prints a message pointing at "M (retire 007)" and aborts, rather than crashing into `EADDRINUSE`.

### Agent status merge

Option 4 now reports both mechanisms in one call: plain-background PID-daemon state, and 007's `{ installed, running, pid? }`, since they're ultimately the same agent and a user shouldn't need to remember two different status commands.

## Testing plan

Manual, since `launch.mjs` has no existing test harness. **This environment is macOS-only** — the Linux and Windows paths (systemd unit generation/commands, Task Scheduler XML generation/commands) are implemented per each platform's documented CLI behavior and reviewed for correctness, but were not executed. That gap is called out explicitly rather than claimed as tested.

macOS (executable here):
1. Install 007; confirm the plist exists, `launchctl list` shows it running, and a client can connect.
2. Confirm crash-restart: kill the underlying process directly, confirm launchd restarts it.
3. Confirm "Agent status" reports 007's state correctly.
4. Confirm starting plain background (option 3) while 007 is active is refused with a clear message.
5. Retire 007; confirm the plist is gone and `launchctl list` no longer finds it.
6. Confirm plain background (option 3) works normally again afterward.

Linux/Windows: code review only (unit/task file syntax checked against official docs; command sequences checked against `systemctl`/`schtasks` documentation) — not run.
