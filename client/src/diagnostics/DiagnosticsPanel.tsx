import { useState } from "react";
import type { DiagnosticCheck, DiagnosticStatus } from "@bcsa/shared";
import type { DiagnosticsState } from "../connect/useConnection";

interface DiagnosticsPanelProps {
  connected: boolean;
  /**
   * Whether video is actually reaching the screen, from ANY source.
   *
   * Must not be derived from the Classic JPEG frame alone: that stays null on
   * both the WebRTC and H.264-over-WebSocket paths, so this check reported
   * "connected but no frames yet" while video was visibly streaming at ~30fps.
   */
  hasFrame: boolean;
  /** Which source is producing them, for the detail line. */
  frameSource?: string;
  /**
   * What the video path is actually doing right now: transport in use, and the
   * codec the decoder was configured with.
   *
   * Reported separately from the agent's own checks because only the client
   * knows which transport WON. The agent can say QUIC is available; whether the
   * browser managed to connect to it — and therefore whether frames are
   * arriving over QUIC or over the WebSocket fallback — is visible only here,
   * and the fallback is silent by design.
   */
  videoPath?: { transport: string; codec: string | null } | null;
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
  frameSource,
  videoPath,
  diagnostics,
  onRun,
  onReconnect,
}: DiagnosticsPanelProps) {
  const [copied, setCopied] = useState(false);
  const hasWebGPU = typeof navigator !== "undefined" && "gpu" in navigator;
  const hasWebCodecs = typeof window !== "undefined" && "VideoDecoder" in window;

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
      ? {
          id: "frames",
          label: "Live frames",
          status: "ok",
          detail: frameSource ? `streaming (${frameSource})` : "screen is streaming",
        }
      : {
          id: "frames",
          label: "Live frames",
          status: connected ? "warn" : "fail",
          detail: connected ? "connected but no frames yet" : "not streaming",
          fix: connected
            ? "Pick Screenshot or Video mode. If it stays blank, run the checks below to inspect the agent's capture."
            : undefined,
        },
    ...(videoPath
      ? [
          {
            id: "video-path",
            label: "Video path",
            status: "ok" as const,
            detail: videoPath.codec
              ? `${videoPath.transport} · ${videoPath.codec}`
              : videoPath.transport,
          },
        ]
      : []),
    hasWebGPU
      ? { id: "gpu", label: "Browser GPU (transcription)", status: "ok", detail: "WebGPU available" }
      : {
          id: "gpu",
          label: "Browser GPU (transcription)",
          status: "warn",
          detail: "WebGPU not available — transcription uses the slower WASM path",
          fix: "Use Chrome or Edge 113+ for GPU-accelerated transcription.",
        },
    hasWebCodecs
      ? { id: "webcodecs", label: "Browser WebCodecs (H.264 video)", status: "ok", detail: "supported" }
      : {
          id: "webcodecs",
          label: "Browser WebCodecs (H.264 video)",
          status: "warn",
          detail: "VideoDecoder unavailable — Video mode falls back to JPEG screenshots",
          fix: "Use a modern browser (Chrome/Edge/Firefox, or Safari 16.4+) for H.264 video.",
        },
  ];

  const agentRows: Row[] = diagnostics.checks;

  const copyReport = () => {
    const line = (r: Row) =>
      `[${r.status.toUpperCase()}] ${r.label} — ${r.detail}${r.fix ? `\n    fix: ${r.fix}` : ""}`;
    const report = [
      "Back·Connector diagnostics",
      new Date().toISOString(),
      "",
      "This browser:",
      ...browserChecks.map(line),
      "",
      agentRows.length ? "Agent:" : "Agent: (not run)",
      ...agentRows.map(line),
    ].join("\n");
    void navigator.clipboard?.writeText(report).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => {},
    );
  };

  return (
    <div className="card">
      <div className="card-head">
        <span className="card-title">Diagnostics</span>
        <div className="diag-actions">
          <button className="btn-mini" onClick={copyReport}>
            {copied ? "Copied ✓" : "Copy"}
          </button>
          <button
            className="btn-mini"
            onClick={onRun}
            disabled={!connected || diagnostics.running}
          >
            {diagnostics.running ? "Checking…" : "Run checks"}
          </button>
        </div>
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
