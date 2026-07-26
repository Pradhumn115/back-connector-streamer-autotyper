import { RTCPeerConnection, MediaStreamTrack } from "werift";
import { VIDEO_CODEC, AUDIO_CODEC } from "./codecs.js";
import { RtpRelay } from "./rtpRelay.js";

const ICE_CONNECT_TIMEOUT_MS = 5000;

/**
 * Strips server-reflexive ("typ srflx") candidate lines from an SDP.
 *
 * Defense-in-depth for `suppressStun()` below: even if that runtime hook
 * ever stops working (e.g. a future werift upgrade restructures its
 * internals), a srflx candidate -- which would carry the host's public IP
 * -- must never reach the client. This project restricts WebRTC to
 * LAN/Tailscale, so only "host" (LAN-local) candidates are ever useful;
 * srflx candidates are both unnecessary and a privacy leak here.
 */
function stripSrflxCandidates(sdp: string): string {
  return sdp
    .split("\r\n")
    .filter((line) => !(line.startsWith("a=candidate:") && / typ srflx(\s|$)/.test(line)))
    .join("\r\n");
}

export interface WebrtcSessionDeps {
  /** Full ffmpeg args (input + `-f rtp rtp://127.0.0.1:<port>` output) for video. */
  videoFfmpegArgs: (port: number) => string[];
  /** Same, for audio. */
  audioFfmpegArgs: (port: number) => string[];
  /** Called whenever the session's active/error state changes. */
  onStateChange: (active: boolean, error?: string) => void;
  /**
   * Overrides the 5s ICE-connect timeout. Test-only escape hatch so the
   * timeout-rejects path can be exercised without waiting the full 5s in
   * the production default; omit in real usage.
   */
  iceConnectTimeoutMs?: number;
}

/**
 * One WebRTC session's worth of state: the peer connection, its two sendonly
 * tracks, and the ffmpeg relays feeding them. Exactly one exists per agent
 * session while WebRTC mode is active; connection/index.ts owns its lifecycle.
 */
export class WebrtcSession {
  private readonly pc: RTCPeerConnection;
  private readonly videoTrack: MediaStreamTrack;
  private readonly audioTrack: MediaStreamTrack;
  private readonly videoRelay: RtpRelay;
  private readonly audioRelay: RtpRelay;
  private closed = false;
  /** Set once awaitConnected() has already reported a failure, so close() doesn't double-report. */
  private failed = false;
  private readonly iceConnectTimeoutMs: number;

  constructor(private readonly deps: WebrtcSessionDeps) {
    this.iceConnectTimeoutMs = deps.iceConnectTimeoutMs ?? ICE_CONNECT_TIMEOUT_MS;
    this.pc = new RTCPeerConnection({
      codecs: { video: [VIDEO_CODEC], audio: [AUDIO_CODEC] },
    });
    this.videoTrack = new MediaStreamTrack({ kind: "video" });
    this.audioTrack = new MediaStreamTrack({ kind: "audio" });
    this.pc.addTransceiver(this.videoTrack, { direction: "sendonly" });
    this.pc.addTransceiver(this.audioTrack, { direction: "sendonly" });
    this.suppressStun();
    this.videoRelay = new RtpRelay("video", deps.videoFfmpegArgs);
    this.audioRelay = new RtpRelay("audio", deps.audioFfmpegArgs);

    // Long-lived watcher: reports a drop that happens *after* the initial
    // connect (e.g. the network disappears mid-session). Guarded by
    // `this.closed` so a deliberate close() never reports itself as a
    // failure, and by `reportFailure`'s own latch so this can't double-fire
    // alongside awaitConnected()'s handling of the *initial* connect attempt.
    this.pc.connectionStateChange.subscribe((state) => {
      if (this.closed) return;
      if (state === "failed" || state === "closed" || state === "disconnected") {
        this.reportFailure(`WebRTC connection ${state}`);
      }
    });
  }

  /** Starts both RTP relays and returns the SDP offer to send to the client. */
  async createOffer(): Promise<string> {
    await Promise.all([
      this.videoRelay.start(this.videoTrack),
      this.audioRelay.start(this.audioTrack),
    ]);
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    return stripSrflxCandidates(this.pc.localDescription!.sdp);
  }

  /** Applies the client's answer and waits for ICE to actually connect. */
  async setAnswer(sdp: string): Promise<void> {
    await this.pc.setRemoteDescription({ type: "answer", sdp });
    await this.awaitConnected();
    // A successful connect means any earlier failure latch (e.g. a
    // transient "disconnected" blip before the first "connected") no
    // longer describes the session's current state. Clear it so a real
    // failure later in the session's life can still reach onStateChange.
    this.failed = false;
    this.deps.onStateChange(true);
  }

  close(): void {
    this.closed = true;
    this.videoRelay.stop();
    this.audioRelay.stop();
    void this.pc.close();
  }

  /**
   * Resolves once `connectionStateChange` reports "connected"; rejects (and
   * fires onStateChange(false, err) exactly once) on "failed"/"closed" or a
   * timeout (5s in production, overridable via `deps.iceConnectTimeoutMs`
   * for tests). No silent fallback: a session that never connects is a hard
   * error, not a fallback to Classic mode here.
   *
   * werift's `Event.subscribe()` does NOT return a bare unsubscribe function
   * (unlike a naive Node EventEmitter wrapper) — it returns
   * `{ unSubscribe: () => void; disposer: (d: EventDisposer) => void }`, so
   * we destructure `unSubscribe` (capital S) and call that to detach.
   *
   * The "failed"/"closed" branches here only reject the promise; they don't
   * call onStateChange themselves — the constructor's long-lived listener
   * (which sees the same event) already does that via reportFailure()'s
   * one-shot latch. Only the timeout branch calls reportFailure directly,
   * since a timeout with no state change firing isn't otherwise observed.
   */
  private awaitConnected(): Promise<void> {
    if (this.pc.connectionState === "connected") return Promise.resolve();
    // Already dead (e.g. a prior "failed"/"closed" event landed before
    // setAnswer() was even called): fail fast instead of waiting out the
    // full timeout for a state change that will never arrive.
    if (this.pc.connectionState === "failed" || this.pc.connectionState === "closed") {
      return Promise.reject(new Error(`WebRTC connection ${this.pc.connectionState}`));
    }
    return new Promise((resolve, reject) => {
      // Declared before both the timer and the subscription (rather than
      // destructured inline in the timer callback) so there's no temporal-
      // dead-zone hazard: `unSubscribe` is assigned synchronously below,
      // before either callback can possibly run, but keeping the
      // declaration order explicit avoids relying on that timing.
      let unSubscribe: () => void;
      const timer = setTimeout(() => {
        unSubscribe();
        const err = `ICE did not connect within ${this.iceConnectTimeoutMs}ms`;
        this.reportFailure(err);
        reject(new Error(err));
      }, this.iceConnectTimeoutMs);
      ({ unSubscribe } = this.pc.connectionStateChange.subscribe((state) => {
        if (state === "connected") {
          clearTimeout(timer);
          unSubscribe();
          resolve();
        } else if (state === "failed" || state === "closed") {
          clearTimeout(timer);
          unSubscribe();
          reject(new Error(`WebRTC connection ${state}`));
        }
      }));
    });
  }

  /** Fires onStateChange(false, err) at most once per session. */
  private reportFailure(err: string): void {
    if (this.failed) return;
    this.failed = true;
    this.deps.onStateChange(false, err);
  }

  /**
   * Prevents werift from ever querying an external STUN server.
   *
   * werift-ice hardcodes a fallback to Google's public STUN server
   * (`stun.l.google.com:19302`) whenever no `stunServer` is configured --
   * this is NOT avoided by passing `iceServers: []` (verified empirically:
   * `validateAddress(undefined) ?? ["stun.l.google.com", 19302]` in
   * werift-ice's ice.js always falls back). Left unpatched, every session
   * would query Google and put the host's public IP into the SDP offer as
   * a server-reflexive (srflx) candidate -- contradicting this project's
   * "no relay server, no external dependency" design (WebRTC here is
   * restricted to LAN/Tailscale, where only "host" candidates are useful).
   *
   * There is no supported `RTCConfiguration` flag to disable STUN
   * gathering, and redirecting/blocking the query (e.g. pointing
   * `iceServers` at an unreachable address) doesn't help either: werift's
   * retry logic ignores the send/lookup failure and still blocks on
   * ice.js's hardcoded 5s gather timeout regardless of *why* the request
   * failed (verified empirically -- both an unreachable loopback target and
   * a synchronously-failing DNS lookup still took ~5s).
   *
   * Instead, each transceiver's `RTCIceTransport` exposes its underlying
   * ice.js `Connection` via a public (if untyped-as-mutable) `.connection`
   * field, which has a plain, assignable `stunServer` property. Setting it
   * to `false` short-circuits werift-ice's `if (stunServer)` gather check
   * entirely: no STUN request is ever sent (confirmed via a `dns.lookup`
   * hook -- zero lookups for `stun.l.google.com`), no srflx candidate is
   * ever produced, and gathering finishes in milliseconds instead of
   * stalling for 5s.
   *
   * This reaches past werift's public types into a field its `.d.ts`
   * doesn't advertise as writable, so it's wrapped in try/catch and backed
   * by `stripSrflxCandidates()` in `createOffer()` as a second line of
   * defense in case a future werift version restructures this shape and
   * this hook silently stops working. The loop itself (including the
   * `iceTransports` getter access) lives inside the try too: if a future
   * werift version renames/removes that getter, or it's ever undefined,
   * this must degrade to best-effort rather than throwing out of the
   * constructor.
   *
   * After the assignment, we read `stunServer` back and log to stderr if
   * it isn't `false`. `stripSrflxCandidates()` only scrubs the leaked
   * candidate from the SDP -- it doesn't stop the underlying STUN request
   * (and its ~5s gather stall) from actually firing. If this hook ever
   * silently no-ops (e.g. on a werift upgrade), that request would still
   * go out to Google with nothing surfacing the regression; this readback
   * at least makes that visible in logs instead of silent.
   */
  private suppressStun(): void {
    try {
      for (const transport of this.pc.iceTransports ?? []) {
        const connection = transport.connection as { stunServer?: unknown };
        connection.stunServer = false;
        if (connection.stunServer !== false) {
          console.error(
            "WebrtcSession: suppressStun() readback shows stunServer is still",
            connection.stunServer,
            "-- STUN leak likely; stripSrflxCandidates() will still scrub the SDP, " +
              "but the external STUN request and its gather stall are not suppressed.",
          );
        }
      }
    } catch {
      // Best-effort; stripSrflxCandidates() in createOffer() is the fallback.
    }
  }
}
