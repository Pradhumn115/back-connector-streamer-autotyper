import { useEffect, useRef, useState } from "react";
import type { StreamMode } from "@bcsa/shared";
import { useConnection } from "./connect/useConnection";
import { useAudioTranscription } from "./audio/useAudioTranscription";
import { useRemoteControl } from "./control/useRemoteControl";
import { useWebrtcConnection } from "./webrtc/useWebrtcConnection";
import { tapWebrtcAudioForTranscription } from "./webrtc/webrtcAudioTap";
import { ScreenView, intervalForMode, type ContentRect } from "./view/ScreenView";
import { AutotypePanel } from "./autotype-panel/AutotypePanel";
import { DiagnosticsPanel } from "./diagnostics/DiagnosticsPanel";

/** Index into buildTargets()'s LAN/Tailscale/Tunnel order for the Tunnel target. */
const TUNNEL_TARGET_INDEX = 2;

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
  const webrtc = useWebrtcConnection();
  const [transport, setTransport] = useState<"classic" | "webrtc">("classic");
  // Holds an incoming WebRTC offer SDP until the effect below can answer it —
  // conn isn't defined yet at the point onWebrtcOffer is declared, so we can't
  // close over conn.sendWebrtcAnswer directly.
  const [pendingOfferSdp, setPendingOfferSdp] = useState<string | null>(null);
  const conn = useConnection({
    onAudioFrame: audioTx.pushFrame,
    onWebrtcOffer: (sdp) => setPendingOfferSdp(sdp),
    onWebrtcState: webrtc.handleAgentState,
  });
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
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
  // Whether the WebRTC <video> element plays its audio track out loud.
  // Defaults off so agent-side audio doesn't start blasting through the
  // client's speakers the moment WebRTC connects; independent of
  // transcription, which taps the same track separately regardless of this.
  const [webrtcAudioEnabled, setWebrtcAudioEnabled] = useState<boolean>(false);

  // Wire mouse/keyboard to whichever surface is active for the current
  // transport; gated by the control toggle. Control (mouse/keyboard/autotype/
  // input-lock) behaves identically either way — only the rendering surface
  // differs.
  const activeSurfaceRef = transport === "webrtc" ? videoRef : canvasRef;
  useRemoteControl(activeSurfaceRef, contentRectRef, conn.send, controlEnabled);

  const connected = conn.status === "connected";

  const refreshHz = conn.agentInfo?.refreshHz;

  // Answer a pending WebRTC offer once conn (and thus sendWebrtcAnswer) exists.
  useEffect(() => {
    if (pendingOfferSdp === null) return;
    const sdp = pendingOfferSdp;
    setPendingOfferSdp(null);
    void webrtc
      .handleOffer(sdp)
      .then((answer) => conn.sendWebrtcAnswer(answer))
      .catch((err) => {
        // handleOffer already records the failure in webrtc.status/error;
        // this catch only prevents an unhandled promise rejection.
        console.error("WebRTC offer handling failed:", err);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingOfferSdp]);

  // No silent fallback: if WebRTC errors out, revert to Classic and surface
  // the error (webrtc.error is already shown via ScreenView/hint text below).
  // Critically, we must tell the agent to stop its WebRTC session *before*
  // (or alongside) re-sending setMode: the agent rejects setMode with
  // "Classic video is paused while WebRTC is active" while its WebRTC
  // session is still up, which would otherwise leave Classic frozen/black
  // even though the toggle says "Classic".
  useEffect(() => {
    if (transport === "webrtc" && webrtc.status === "error") {
      conn.stopWebrtc();
      setTransport("classic");
      conn.send({ type: "setMode", mode, intervalMs: intervalForMode(mode, refreshHz) });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [webrtc.status]);

  // Tap the WebRTC audio track into the existing (unmodified) transcription
  // pipeline whenever a stream is live, feeding the same pushFrame() the
  // Classic PCM-over-WS path uses. Unlike Classic mode, WebRTC audio already
  // flows continuously as part of the peer connection -- there's no agent-side
  // start/stop signal to send, so the tap is unconditional whenever a stream
  // exists. pushFrame() itself gates on audioTx's mode/liveActive/recording
  // refs, so tapping while the user hasn't turned on transcription is a
  // harmless no-op. This deliberately does NOT touch audioTx's mode/live/
  // record state on entry or exit: whatever the user had going (live
  // captions on, a recording in progress, or neither) carries straight
  // through a transport switch instead of being forced then restored.
  useEffect(() => {
    if (transport !== "webrtc" || !webrtc.stream) return;
    return tapWebrtcAudioForTranscription(webrtc.stream, audioTx.pushFrame);
  }, [transport, webrtc.stream, audioTx.pushFrame]);

  // On (re)connect, tell the agent the current mode so streaming starts, and
  // auto-run diagnostics once so the panel is populated without a manual press.
  useEffect(() => {
    if (connected) {
      conn.send({ type: "setMode", mode, intervalMs: intervalForMode(mode, refreshHz) });
      conn.runDiagnostics();
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

  const onSetTransport = (next: "classic" | "webrtc") => {
    if (next === transport) return;
    if (next === "webrtc") {
      // Reset to a clean "idle" status before each attempt. Without this, a
      // second identical failure leaves webrtc.status stuck at "error" (it
      // never changes value), so the effect above — which only fires on a
      // webrtc.status *transition* — never re-runs and the toggle stays
      // stuck on WebRTC with a black surface.
      webrtc.stop();
      setTransport("webrtc");
      conn.startWebrtc();
    } else {
      setTransport("classic");
      conn.stopWebrtc();
      webrtc.stop();
      conn.send({ type: "setMode", mode, intervalMs: intervalForMode(mode, refreshHz) });
      // Transcription state (live captions on, or a recording in progress)
      // carries straight through the transport switch (see the WebRTC tap
      // effect above), but the agent itself stopped pushing Classic PCM the
      // moment WebRTC started (handleStartWebrtc() calls audio.stop()) and
      // was never told to resume it -- WebRTC audio needed no such signal.
      // Ask it to resume now, or the transcript would otherwise go silently
      // dark on the way back to Classic.
      if (audioTx.liveActive || audioTx.recording) conn.setAudio(true);
    }
  };

  // Live captions: continuous, VAD-gated transcription. Under WebRTC, audio
  // already flows continuously as part of the peer connection -- there's no
  // agent-side stream to start/stop, and the agent actively rejects setAudio
  // while a WebRTC session is active ("Classic audio is paused while WebRTC
  // is active"), so that call only applies to Classic mode.
  const onToggleLive = (on: boolean) => {
    if (on) {
      audioTx.startLive();
      if (transport === "classic") conn.setAudio(true);
    } else {
      if (transport === "classic") conn.setAudio(false);
      audioTx.stopLive();
    }
  };

  // Record mode: buffer the take while recording; transcribe it on pause.
  // Same Classic-only caveat as onToggleLive above.
  const onRecordToggle = () => {
    if (audioTx.recording) {
      if (transport === "classic") conn.setAudio(false);
      void audioTx.pauseRecording();
    } else {
      audioTx.startRecording();
      if (transport === "classic") conn.setAudio(true);
    }
  };

  // Switching modes stops any active capture/transcription first. Same
  // Classic-only caveat as onToggleLive/onRecordToggle above.
  const onSwitchMode = (next: "live" | "record") => {
    if (next === audioTx.mode) return;
    if (transport === "classic") conn.setAudio(false);
    audioTx.setMode(next);
  };

  // Stop live transcription if the connection drops (audio stops arriving).
  useEffect(() => {
    if (!connected) audioTx.stopLive();
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
        {webrtc.error && (
          <>
            <span className="status-sep">/</span>
            <span className="status-error">WebRTC: {webrtc.error}</span>
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
            transport={transport}
            onSetTransport={onSetTransport}
            transportGateDisabled={
              !connected || conn.connectedTargetIndex === TUNNEL_TARGET_INDEX
            }
            webrtcStream={webrtc.stream}
            videoRef={videoRef}
            webrtcAudioEnabled={webrtcAudioEnabled}
            onToggleWebrtcAudio={setWebrtcAudioEnabled}
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
            hasFrame={conn.latestFrame !== null}
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
