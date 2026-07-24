import { useEffect, useRef, useState } from "react";
import type { StreamMode } from "@bcsa/shared";
import { useConnection } from "./connect/useConnection";
import { useRemoteControl } from "./control/useRemoteControl";
import { ScreenView, intervalForMode, type ContentRect } from "./view/ScreenView";
import { AutotypePanel } from "./autotype-panel/AutotypePanel";

export function App() {
  const conn = useConnection();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // The letterbox rectangle the frame occupies inside the canvas, shared between
  // the view (which computes it) and the control layer (which maps clicks with it).
  const contentRectRef = useRef<ContentRect>({ dx: 0, dy: 0, dw: 0, dh: 0 });

  // Connect-bar form fields, seeded from cached params.
  const [lan, setLan] = useState<string>(conn.params.lanAddress);
  const [ts, setTs] = useState<string>(conn.params.tailscaleAddress);
  const [tunnel, setTunnel] = useState<string>(conn.params.tunnelAddress);
  const [secret, setSecret] = useState<string>(conn.params.secret);

  const [mode, setMode] = useState<StreamMode>("screenshot");
  const [controlEnabled, setControlEnabled] = useState<boolean>(false);
  const [panelOpen, setPanelOpen] = useState<boolean>(true);

  // Wire mouse/keyboard to the canvas; gated by the control toggle.
  useRemoteControl(canvasRef, contentRectRef, conn.send, controlEnabled);

  const connected = conn.status === "connected";

  const refreshHz = conn.agentInfo?.refreshHz;

  // On (re)connect, tell the agent the current mode so streaming starts.
  useEffect(() => {
    if (connected) {
      conn.send({ type: "setMode", mode, intervalMs: intervalForMode(mode, refreshHz) });
    }
    // Only fire on transition into connected; mode changes are handled by
    // onSetMode which sends its own setMode.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected]);

  const onConnect = () => {
    conn.connect({
      lanAddress: lan,
      tailscaleAddress: ts,
      tunnelAddress: tunnel,
      secret,
    });
  };

  const onSetMode = (next: StreamMode) => {
    setMode(next);
    conn.send({ type: "setMode", mode: next, intervalMs: intervalForMode(next, refreshHz) });
  };

  const statusText = (() => {
    switch (conn.status) {
      case "connected":
        return "connected";
      case "connecting":
        return "connecting…";
      case "authenticating":
        return "authenticating…";
      case "reconnecting":
        return "reconnecting…";
      case "error":
        return "error";
      default:
        return "idle";
    }
  })();

  const canConnect = conn.status === "idle" || conn.status === "error";

  return (
    <div className="app">
      <header className="topbar">
        <div className={`brand ${connected ? "is-live" : ""}`}>
          <span className="brand-mark" />
          <span className="brand-name">
            Back<b>·</b>Connector
          </span>
          <span className="live-pill">{connected ? "LIVE" : "OFFLINE"}</span>
        </div>

        <div className="conn-fields">
          <input
            className="field-input"
            placeholder="LAN  host:port"
            value={lan}
            onChange={(e) => setLan(e.target.value)}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
          <input
            className="field-input"
            placeholder="Tailscale  host:port"
            value={ts}
            onChange={(e) => setTs(e.target.value)}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
          <input
            className="field-input"
            placeholder="Tunnel  host"
            value={tunnel}
            onChange={(e) => setTunnel(e.target.value)}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
          <input
            className="field-input"
            type="password"
            placeholder="secret"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
          />
        </div>

        <div className="topbar-actions">
          {canConnect ? (
            <button className="btn btn-primary" onClick={onConnect}>
              Connect
            </button>
          ) : (
            <button className="btn btn-danger" onClick={conn.disconnect}>
              Disconnect
            </button>
          )}
          <button
            className="btn btn-ghost panel-toggle-desktop"
            onClick={() => setPanelOpen((v) => !v)}
          >
            {panelOpen ? "Hide" : "Panel"}
          </button>
        </div>
      </header>

      <div className="status-strip">
        <span className={`status-dot s-${conn.status}`} />
        <span className="status-text">{statusText}</span>
        {connected && conn.agentInfo && (
          <>
            <span className="status-sep">/</span>
            <span>{conn.agentInfo.nickname}</span>
            <span className="status-sep">/</span>
            <span>
              {conn.agentInfo.screenWidth}×{conn.agentInfo.screenHeight}
            </span>
          </>
        )}
        {conn.lastError && (
          <>
            <span className="status-sep">/</span>
            <span className="status-error">{conn.lastError}</span>
          </>
        )}
      </div>

      <div className={`workspace ${panelOpen ? "" : "panel-closed"}`}>
        <main className="stage">
          <ScreenView
            frame={conn.latestFrame}
            mode={mode}
            controlEnabled={controlEnabled}
            onSetMode={onSetMode}
            canvasRef={canvasRef}
            contentRectRef={contentRectRef}
            refreshHz={refreshHz}
          />
        </main>

        <aside className="panel">
          <div className="card">
            <label className="switch">
              <input
                type="checkbox"
                checked={controlEnabled}
                onChange={(e) => setControlEnabled(e.target.checked)}
                disabled={!connected}
              />
              <span className="switch-track" />
              <span className="switch-label">Remote control</span>
            </label>
            <p className="hint">
              When on, your mouse &amp; keyboard over the screen drive the agent.
              Click the screen to focus it for keystrokes.
            </p>
          </div>

          <div className="card">
            <label className="switch">
              <input
                type="checkbox"
                checked={conn.inputLock.locked}
                onChange={(e) =>
                  conn.send({ type: "setInputLock", locked: e.target.checked })
                }
                disabled={!connected || !conn.inputLock.supported}
              />
              <span className="switch-track" />
              <span className="switch-label">Lock agent's local input</span>
            </label>
            <p className={`hint ${conn.inputLock.locked ? "warn" : ""}`}>
              {connected && !conn.inputLock.supported
                ? "Not supported on this agent's OS yet."
                : conn.inputLock.locked
                  ? "Agent's physical keyboard/mouse are blocked. Auto-releases after 10s idle or on disconnect."
                  : "Blocks the person at the agent from interfering — only your input gets through."}
            </p>
          </div>

          <AutotypePanel
            send={conn.send}
            autotype={conn.autotype}
            disabled={!connected}
          />
        </aside>
      </div>

      <button className="panel-fab" onClick={() => setPanelOpen((v) => !v)}>
        {panelOpen ? "✕ Close" : "⚙ Controls"}
      </button>
    </div>
  );
}
