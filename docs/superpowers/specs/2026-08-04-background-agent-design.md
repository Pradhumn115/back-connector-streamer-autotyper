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
  - Otherwise spawns `npm run agent` with `detached: true`, `windowsHide: true`, stdout/stderr redirected to an fd opened on the log file (append mode), and calls `.unref()` so the parent can exit without taking the child down.
  - Writes the child's PID to the PID file, prints confirmation with the log path.
- **`agentStatus()`**
  - Reads the PID file. If absent, reports "not running."
  - If present, checks liveness with `process.kill(pid, 0)` (throws `ESRCH` if the process doesn't exist — works cross-platform in Node, including Windows).
  - If dead, reports "not running (stale pid file removed)" and deletes the PID file.
  - If alive, reports "running (pid N)" and the log file path.
- **`stopAgentBackground()`**
  - Reads the PID file. If absent, reports "not running."
  - If present and alive, calls `process.kill(pid)` and deletes the PID file, reports "stopped."
  - If present and dead, reports "not running (stale pid file removed)" and deletes the PID file.

### Menu changes

Insert three new entries after the existing "Run agent", renumbering everything after:

```
1  Full setup
2  Run agent              (unchanged, foreground)
3  Run agent (background) (new)
4  Agent status           (new)
5  Stop background agent  (new)
6  Run client
7  Run tunnel
8  Rebuild
9  Local test
q  Quit
```

## Error handling

- Starting when already running: no-op with a message, never spawns a duplicate.
- Stale PID file (process died without cleanup): status/stop detect via the liveness check and clean up the file rather than erroring.
- No PID file: status/stop just report "not running."

## Out of scope

- Surviving a reboot (would require an OS-level service — launchd/systemd — not requested).
- Auto-restart on crash.
- Backgrounding the client or tunnel.
- npm scripts / CLI flags for non-interactive triggering (menu-only, per user choice).

## Testing plan

Manual, since `launch.mjs` has no existing test harness:

1. Start in background from the menu; confirm the process shows in `ps` and the PID file/log file exist.
2. Confirm starting again while already running reports "already running" and does not spawn a second process.
3. Confirm "Agent status" reports the correct running/not-running state.
4. Stop via the menu; confirm the process is gone and the PID file is removed.
5. Confirm "Agent status" and "Stop" against a stale PID file (process killed out-of-band) clean up correctly instead of erroring.
