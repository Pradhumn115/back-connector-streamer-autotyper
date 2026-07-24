import { useEffect, useRef, useState } from "react";
import type { StreamMode } from "@bcsa/shared";
import { useConnection } from "./connect/useConnection";
import { useRemoteControl } from "./control/useRemoteControl";
import { ScreenView, MODE_INTERVAL_MS } from "./view/ScreenView";
import { AutotypePanel } from "./autotype-panel/AutotypePanel";

export function App() {
  const conn = useConnection();
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Connect-bar form fields, seeded from cached params.
  const [lan, setLan] = useState<string>(conn.params.lanAddress);
  const [ts, setTs] = useState<string>(conn.params.tailscaleAddress);
  const [secret, setSecret] = useState<string>(conn.params.secret);

  const [mode, setMode] = useState<StreamMode>("screenshot");
  const [controlEnabled, setControlEnabled] = useState<boolean>(false);
  const [panelOpen, setPanelOpen] = useState<boolean>(true);

  // Wire mouse/keyboard to the canvas; gated by the control toggle.
  useRemoteControl(canvasRef, conn.send, controlEnabled);

  const connected = conn.status === "connected";

  // On (re)connect, tell the agent the current mode so streaming starts.
  useEffect(() => {
    if (connected) {
      conn.send({
        type: "setMode",
        mode,
        intervalMs: MODE_INTERVAL_MS[mode],
      });
    }
    // Only fire on transition into connected; mode changes are handled by
    // onSetMode which sends its own setMode.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected]);

  const onConnect = () => {
    conn.connect({
      lanAddress: lan,
      tailscaleAddress: ts,
      secret,
    });
  };

  const onSetMode = (next: StreamMode) => {
    setMode(next);
    conn.send({
      type: "setMode",
      mode: next,
      intervalMs: MODE_INTERVAL_MS[next],
    });
  };

  const statusLabel = (() => {
    switch (conn.status) {
      case "connected":
        return conn.agentInfo
          ? `connected · ${conn.agentInfo.nickname} · ${conn.agentInfo.screenWidth}×${conn.agentInfo.screenHeight}`
          : "connected";
      case "connecting":
        return "connecting…";
      case "authenticating":
        return "authenticating…";
      case "reconnecting":
        return "reconnecting…";
      case "error":
        return `error${conn.lastError ? `: ${conn.lastError}` : ""}`;
      default:
        return "idle";
    }
  })();

  return (
    <div className="app">
      <header className="connect-bar">
        <input
          className="addr"
          placeholder="LAN host:port"
          value={lan}
          onChange={(e) => setLan(e.target.value)}
        />
        <input
          className="addr"
          placeholder="Tailscale host:port (optional)"
          value={ts}
          onChange={(e) => setTs(e.target.value)}
        />
        <input
          className="secret"
          type="password"
          placeholder="secret"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
        />
        {conn.status === "idle" || conn.status === "error" ? (
          <button className="primary" onClick={onConnect}>
            Connect
          </button>
        ) : (
          <button onClick={conn.disconnect}>Disconnect</button>
        )}
        <span className={`status status-${conn.status}`}>{statusLabel}</span>
        <button
          className="panel-toggle"
          onClick={() => setPanelOpen((v) => !v)}
        >
          {panelOpen ? "Hide panel" : "Show panel"}
        </button>
      </header>

      <div className="body">
        <main className="main">
          <ScreenView
            frame={conn.latestFrame}
            mode={mode}
            controlEnabled={controlEnabled}
            onSetMode={onSetMode}
            canvasRef={canvasRef}
          />
        </main>

        {panelOpen && (
          <aside className="side-panel">
            <div className="control-toggle">
              <label>
                <input
                  type="checkbox"
                  checked={controlEnabled}
                  onChange={(e) => setControlEnabled(e.target.checked)}
                  disabled={!connected}
                />
                Control enabled
              </label>
              <p className="hint">
                When on, mouse & keyboard on the screen are sent to the agent.
                Click the screen to focus it for keys.
              </p>
            </div>

            <AutotypePanel
              send={conn.send}
              autotype={conn.autotype}
              disabled={!connected}
            />
          </aside>
        )}
      </div>
    </div>
  );
}
