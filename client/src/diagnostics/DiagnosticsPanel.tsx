import type { DiagnosticCheck, DiagnosticStatus } from "@bcsa/shared";
import type { DiagnosticsState } from "../connect/useConnection";

interface DiagnosticsPanelProps {
  connected: boolean;
  hasFrame: boolean;
  diagnostics: DiagnosticsState;
  onRun: () => void;
  /** Safe in-app auto-fix: retry the connection with the current fields. */
  onReconnect: () => void;
}

/** A rendered row — either a browser-side check or an agent-reported one. */
interface Row extends DiagnosticCheck {
  action?: { label: string; run: () => void };
}

/**
 * Diagnostics: runs browser-side checks immediately and asks the agent to run
 * its own self-checks. Reports each with a fix. Fixes are guidance; the only
 * actions offered are safe, in-app ones (reconnect) — the client never runs
 * commands on the agent.
 */
export function DiagnosticsPanel({
  connected,
  hasFrame,
  diagnostics,
  onRun,
  onReconnect,
}: DiagnosticsPanelProps) {
  const hasWebGPU = typeof navigator !== "undefined" && "gpu" in navigator;

  const browserChecks: Row[] = [
    connected
      ? { id: "conn", label: "Connection", status: "ok", detail: "connected to the agent" }
      : {
          id: "conn",
          label: "Connection",
          status: "fail",
          detail: "not connected",
          fix: "Enter the agent's address + secret above, then press Connect.",
          action: { label: "Reconnect", run: onReconnect },
        },
    hasFrame
      ? { id: "frames", label: "Live frames", status: "ok", detail: "screen is streaming" }
      : {
          id: "frames",
          label: "Live frames",
          status: connected ? "warn" : "fail",
          detail: connected ? "connected but no frames yet" : "not streaming",
          fix: connected
            ? "Pick Screenshot or Video mode. If it stays blank, run the checks below to inspect the agent's capture."
            : undefined,
        },
    hasWebGPU
      ? { id: "gpu", label: "Browser GPU (transcription)", status: "ok", detail: "WebGPU available" }
      : {
          id: "gpu",
          label: "Browser GPU (transcription)",
          status: "warn",
          detail: "WebGPU not available — transcription uses the slower WASM path",
          fix: "Use Chrome or Edge 113+ for GPU-accelerated transcription.",
        },
  ];

  const agentRows: Row[] = diagnostics.checks;

  return (
    <div className="card">
      <div className="card-head">
        <span className="card-title">Diagnostics</span>
        <button
          className="btn-mini"
          onClick={onRun}
          disabled={!connected || diagnostics.running}
        >
          {diagnostics.running ? "Checking…" : "Run checks"}
        </button>
      </div>

      <div className="diag-group-label">This browser</div>
      <DiagList rows={browserChecks} />

      <div className="diag-group-label">
        Agent{agentRows.length === 0 ? " — press Run checks" : ""}
      </div>
      {agentRows.length > 0 && <DiagList rows={agentRows} />}
    </div>
  );
}

function DiagList({ rows }: { rows: Row[] }) {
  return (
    <ul className="diag-list">
      {rows.map((r) => (
        <li className="diag-row" key={r.id}>
          <span className={`diag-dot d-${statusClass(r.status)}`} aria-hidden />
          <div className="diag-body">
            <div className="diag-label">
              {r.label} <span className="diag-detail">— {r.detail}</span>
            </div>
            {r.fix && <div className="diag-fix">{r.fix}</div>}
            {r.action && (
              <button className="btn-mini diag-action" onClick={r.action.run}>
                {r.action.label}
              </button>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

function statusClass(s: DiagnosticStatus): string {
  return s; // "ok" | "warn" | "fail" map directly to CSS classes
}
