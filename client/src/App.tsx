import { useEffect, useRef, useState } from "react";
import type { StreamMode } from "@bcsa/shared";
import { useConnection } from "./connect/useConnection";
import { useAudioTranscription } from "./audio/useAudioTranscription";
import { useRemoteControl } from "./control/useRemoteControl";
import { ScreenView, intervalForMode, type ContentRect } from "./view/ScreenView";
import { useH264Decoder } from "./view/useH264Decoder";
import { useWebtransport } from "./connect/useWebtransport";
import { AutotypePanel } from "./autotype-panel/AutotypePanel";
import { DiagnosticsPanel } from "./diagnostics/DiagnosticsPanel";

/** Format elapsed milliseconds as M:SS for the record timer. */
function fmtElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function App() {
  // Owns the Whisper worker; conn feeds it decoded audio frames.
  const audioTx = useAudioTranscription();
  // Declared before useConnection because the H.264 decoder needs the canvas
  // and useConnection needs the decoder's pushFrame.
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // H.264 frames bypass the image path entirely and go to a WebCodecs decoder
  // that paints straight onto the Classic canvas — same surface, same click
  // mapping, so remote control needs no special case for it.
  const h264 = useH264Decoder(canvasRef);
  // Video can arrive over QUIC instead of the control socket. Frames carry the
  // same envelope either way, so both feed the same decoder and the fallback is
  // invisible to everything downstream.
  const wt = useWebtransport(h264.pushFrame);
  const conn = useConnection({
    onAudioFrame: audioTx.pushFrame,
    onVideoFrame: h264.pushFrame,
  });
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

  // Wire mouse/keyboard to the canvas, gated by the control toggle. Video of
  // every kind lands on that one surface, so control needs no special case.
  useRemoteControl(canvasRef, contentRectRef, conn.send, controlEnabled);

  const connected = conn.status === "connected";

  const refreshHz = conn.agentInfo?.refreshHz;

  // Attach to the agent's QUIC listener once it advertises one.
  //
  // Opportunistic: a browser without WebTransport, or a Cloudflare Tunnel with
  // no UDP route, simply never connects and keeps taking video over the
  // WebSocket — which the agent goes on sending until a session appears.
  const wtInfo = conn.agentInfo?.webtransport;
  const wtHost = conn.connectedHost;
  useEffect(() => {
    if (!connected || !wtInfo || !wtHost) {
      wt.disconnect();
      return;
    }
    wt.connect(wtHost, wtInfo.port, wtInfo.certHash);
    return () => wt.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, wtInfo?.port, wtInfo?.certHash, wtHost]);

  // On (re)connect, tell the agent the current mode so streaming starts, and
  // auto-run diagnostics once so the panel is populated without a manual press.
  useEffect(() => {
    if (!connected) return;
    conn.send({ type: "setMode", mode, intervalMs: intervalForMode(mode, refreshHz) });
    conn.runDiagnostics();
    // Only fire on transition into connected; mode changes send their own
    // setMode from onSetMode.
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

  // Live captions: continuous, VAD-gated transcription. Audio always arrives
  // as PCM over the WebSocket, so it is started and stopped unconditionally.
  const onToggleLive = (on: boolean) => {
    if (on) {
      audioTx.startLive();
      conn.setAudio(true);
    } else {
      conn.setAudio(false);
      audioTx.stopLive();
    }
  };

  // Record mode: buffer the take while recording; transcribe it on pause.
  const onRecordToggle = () => {
    if (audioTx.recording) {
      conn.setAudio(false);
      void audioTx.pauseRecording();
    } else {
      audioTx.startRecording();
      conn.setAudio(true);
    }
  };

  // Switching modes stops any active capture/transcription first.
  const onSwitchMode = (next: "live" | "record") => {
    if (next === audioTx.mode) return;
    conn.setAudio(false);
    audioTx.setMode(next);
  };

  // Stop live transcription if the connection drops (audio stops arriving),
  // and drop the H.264 decoder with it — it was primed against a keyframe from
  // a stream that no longer exists, and reusing it against the next one leaves
  // the picture frozen or corrupt.
  useEffect(() => {
    if (!connected) {
      audioTx.stopLive();
      h264.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected]);

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
            h264={{ active: h264.active, fps: h264.fps, status: h264.status, error: h264.error }}
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

          <div className="card">
            <div className="card-head">
              <span className="card-title">Transcribe audio</span>
              <div className="seg seg-sm">
                <button
                  className={audioTx.mode === "live" ? "active" : ""}
                  onClick={() => onSwitchMode("live")}
                  disabled={!connected || !conn.audio.supported}
                >
                  Live
                </button>
                <button
                  className={audioTx.mode === "record" ? "active" : ""}
                  onClick={() => onSwitchMode("record")}
                  disabled={!connected || !conn.audio.supported}
                >
                  Record
                </button>
              </div>
            </div>

            {/* Model picker: lets you A/B the two STT models' output quality
                and per-utterance latency (see lastLatencyMs in the hint below)
                without restarting the session. Switching re-triggers a load
                only the first time a given model is picked. */}
            <div className="model-picker">
              <span className="model-picker-label">Model</span>
              <div className="seg seg-sm">
                <button
                  className={audioTx.model === "whisper" ? "active" : ""}
                  onClick={() => audioTx.setModel("whisper")}
                  title="onnx-community/whisper-base.en"
                >
                  Whisper
                </button>
                <button
                  className={audioTx.model === "moonshine" ? "active" : ""}
                  onClick={() => audioTx.setModel("moonshine")}
                  title="onnx-community/moonshine-base-ONNX"
                >
                  Moonshine
                </button>
              </div>
            </div>

            {audioTx.mode === "live" ? (
              <label className="switch">
                <input
                  type="checkbox"
                  checked={audioTx.liveActive}
                  onChange={(e) => onToggleLive(e.target.checked)}
                  disabled={!connected || !conn.audio.supported}
                />
                <span className="switch-track" />
                <span className="switch-label">Live captions</span>
              </label>
            ) : (
              <div className="record-row">
                <button
                  className={`btn ${audioTx.recording ? "btn-danger" : "btn-primary"}`}
                  onClick={onRecordToggle}
                  disabled={!connected || !conn.audio.supported || audioTx.transcribing}
                >
                  {audioTx.recording ? "⏸ Pause & transcribe" : "⏺ Record"}
                </button>
                {(audioTx.recording || audioTx.elapsedMs > 0) && (
                  <span className="record-time">{fmtElapsed(audioTx.elapsedMs)}</span>
                )}
              </div>
            )}

            {/* Play back the last take. The same audio that was transcribed,
                kept as a WAV so a wrong-looking transcript can be checked
                against what was actually captured. */}
            {audioTx.mode === "record" && audioTx.recordingUrl && (
              <div className="playback">
                <audio controls src={audioTx.recordingUrl} className="playback-audio" />
                <a
                  className="btn btn-ghost btn-xs"
                  href={audioTx.recordingUrl}
                  download="recording.wav"
                >
                  Download
                </a>
              </div>
            )}

            <p className={`hint ${audioTx.status === "error" ? "warn" : ""}`}>
              {connected && !conn.audio.supported
                ? "No loopback device on the agent — install BlackHole (macOS) / VB-Cable (Windows). See README."
                : audioTx.status === "loading"
                  ? `Loading speech model… ${audioTx.progress}%`
                  : audioTx.status === "error"
                    ? `Model error: ${audioTx.error ?? "failed to load"}`
                    : audioTx.transcribing
                      ? "Transcribing the recording…"
                      : audioTx.mode === "record"
                        ? "Record a take, then Pause to transcribe the whole thing."
                        : audioTx.status === "ready"
                          ? `Live captions${audioTx.device ? ` · ${audioTx.device}` : ""}${audioTx.lastLatencyMs !== null ? ` · last ${audioTx.lastLatencyMs}ms` : ""} — speech only, silence skipped.`
                          : "Transcribes whatever's playing on the agent to text, in your browser."}
            </p>

            {(audioTx.transcript || audioTx.status === "ready" || audioTx.transcribing) && (
              <div className="transcript">
                <div className="transcript-head">
                  <span>Transcript</span>
                  <button className="btn btn-ghost btn-xs" onClick={audioTx.reset}>
                    Clear
                  </button>
                </div>
                <div className="transcript-body">
                  {audioTx.transcript || (
                    <span className="transcript-empty">
                      {audioTx.transcribing
                        ? "Transcribing…"
                        : audioTx.mode === "record"
                          ? "Press Record to start."
                          : "Listening…"}
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>

          <AutotypePanel
            send={conn.send}
            autotype={conn.autotype}
            disabled={!connected}
          />

          <DiagnosticsPanel
            connected={connected}
            // Video reaches the canvas by three different routes, and only one
            // of them produces a `latestFrame`. Reporting on that alone told
            // the user "no frames yet" while the screen was visibly updating.
            hasFrame={conn.latestFrame !== null || h264.active}
            videoPath={
              h264.active
                ? {
                    transport: wt.frames > 0 ? "QUIC (WebTransport)" : "WebSocket (TCP)",
                    codec: h264.codec,
                  }
                : conn.latestFrame !== null
                  ? { transport: "WebSocket (TCP)", codec: "MJPEG" }
                  : null
            }
            frameSource={
              h264.active
                ? wt.frames > 0
                  ? "H.264 over QUIC"
                  : "H.264 over WebSocket"
                : conn.latestFrame !== null
                  ? "MJPEG"
                  : undefined
            }
            diagnostics={conn.diagnostics}
            onRun={conn.runDiagnostics}
            onReconnect={onConnect}
          />
        </aside>
      </div>

      <button className="panel-fab" onClick={() => setPanelOpen((v) => !v)}>
        {panelOpen ? "✕ Close" : "⚙ Controls"}
      </button>
    </div>
  );
}
