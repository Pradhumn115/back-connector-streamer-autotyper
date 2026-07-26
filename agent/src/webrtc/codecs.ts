import { RTCRtpCodecParameters } from "werift";

/**
 * A codec choice offered to the browser, plus everything needed to encode
 * ffmpeg output that actually conforms to it. WebRTC codec negotiation is
 * answerer's-choice: the offer lists every tier below (payloadType-distinct
 * `a=rtpmap`/`a=fmtp` entries under the same `m=video` line, in preference
 * order), and each browser's SDP answer keeps only the payload type(s) its
 * decoder actually supports. werift's transceiver.codecs getter reflects
 * that intersection after setRemoteDescription() resolves — see
 * session.ts's setAnswer(), which reads it to pick the matching tier here
 * before starting the video ffmpeg encode.
 *
 * This is why a single fixed codec kept breaking one browser or another:
 * Chrome's RTCRtpSender.getCapabilities('video') (queried live) tops out at
 * High profile/Level 5.2 (640034) and Safari doesn't support that level at
 * all, but every major browser (Chrome, Safari, Firefox, Edge) supports
 * Constrained Baseline/Level 3.1 (42e01f) -- the WebRTC spec's "mandatory
 * to implement" H.264 combination. Offering both lets capable browsers get
 * the higher-quality/higher-fps encode while everything else still works.
 */
export interface VideoCodecTier {
  codec: RTCRtpCodecParameters;
  /** ffmpeg `-profile:v` value matching this tier's profile-level-id. */
  ffmpegProfile: string;
  /** ffmpeg `-level` value matching this tier's profile-level-id. */
  ffmpegLevel: string;
  /**
   * Resolution cap (pixels wide) for this tier's ffmpeg encode, or `null`
   * for native/uncapped. Mirrors Classic capture's own `maxWidth` pattern
   * (see capture/ffmpeg.ts) via `-vf fps=N,scale='min(W,iw)':-2`.
   */
  maxWidth: number | null;
  /** fps cap for this tier's ffmpeg encode. */
  maxFps: number;
  /**
   * Bitrate ceiling for this tier's encode, in kbit/s, applied as
   * `-b:v`/`-maxrate` with a half-size `-bufsize`.
   *
   * Not cosmetic: without an explicit rate cap libx264 encodes at its
   * default CRF, which on a native-resolution desktop at high fps produces
   * bursts of tens of Mbit/s. Nothing in this pipeline reacts to congestion
   * -- the `goog-remb` feedback advertised in the rtcpFeedback lists below
   * is negotiated but never read, and ffmpeg has no back-channel from the
   * peer connection -- so an uncapped encoder simply overruns whatever the
   * link can carry. The resulting packet loss is invisible on a LAN and
   * fatal over Tailscale/Cloudflare, which is exactly the "connected but no
   * picture" asymmetry this transport kept exhibiting.
   *
   * These are deliberately conservative: screen content is highly
   * compressible (large flat regions, few full-frame changes), so the cap is
   * only reached during heavy motion such as video playback or scrolling.
   */
  maxBitrateKbps: number;
}

/**
 * High profile, Level 5.2 (profile-level-id 640034) -- the highest
 * level+profile Chrome's own WebRTC decoder actually supports (confirmed
 * via RTCRtpSender.getCapabilities('video')). Not supported by Safari, so
 * this tier only wins negotiation on browsers that advertise it.
 */
export const VIDEO_CODEC_HIGH: VideoCodecTier = {
  codec: new RTCRtpCodecParameters({
    mimeType: "video/H264",
    clockRate: 90000,
    payloadType: 96,
    parameters: "profile-level-id=640034;packetization-mode=1;level-asymmetry-allowed=1",
    rtcpFeedback: [
      { type: "ccm", parameter: "fir" },
      { type: "nack" },
      { type: "nack", parameter: "pli" },
      { type: "goog-remb" },
    ],
  }),
  ffmpegProfile: "high",
  ffmpegLevel: "5.2",
  maxWidth: null,
  maxFps: 60,
  maxBitrateKbps: 8000,
};

/**
 * Constrained Baseline, Level 3.1 (profile-level-id 42e01f),
 * packetization-mode 1 -- the WebRTC "mandatory to implement" combination
 * every major browser supports natively: Chrome/Edge, Safari (Apple
 * VideoToolbox hardware decode), and Firefox (bundled OpenH264).
 * Constrained Baseline forbids B-frames (no reference-frame buffering, so
 * no added latency) and has the broadest hardware-decode support of any
 * H.264 profile, down to 15-year-old and low-power devices.
 *
 * Level 3.1's macroblock-rate budget (MaxMBPS=108,000 MB/s, MaxFS=3,600 MB)
 * is *exactly* 1280x720 @ 30fps -- the resolution/fps pair the level was
 * standardized around -- so this tier's maxWidth/maxFps caps aren't
 * arbitrary, they're the level's own conformance limits.
 */
export const VIDEO_CODEC_BASELINE: VideoCodecTier = {
  codec: new RTCRtpCodecParameters({
    mimeType: "video/H264",
    clockRate: 90000,
    payloadType: 97,
    parameters: "profile-level-id=42e01f;packetization-mode=1;level-asymmetry-allowed=1",
    rtcpFeedback: [
      { type: "ccm", parameter: "fir" },
      { type: "nack" },
      { type: "nack", parameter: "pli" },
      { type: "goog-remb" },
    ],
  }),
  ffmpegProfile: "baseline",
  ffmpegLevel: "3.1",
  maxWidth: 1280,
  maxFps: 30,
  maxBitrateKbps: 2500,
};

/**
 * Offered to the browser in this order (highest quality first) -- the
 * offerer's preference order is what most browsers use to break ties when
 * more than one listed codec is supported, so capable browsers land on
 * VIDEO_CODEC_HIGH while everything else falls through to the universal
 * VIDEO_CODEC_BASELINE.
 */
export const VIDEO_CODEC_TIERS: VideoCodecTier[] = [VIDEO_CODEC_HIGH, VIDEO_CODEC_BASELINE];

/**
 * Opus at 48 kHz. Per RFC 7587 §5.1, the RTP payload format for Opus MUST
 * always declare `channels: 2` in the rtpmap regardless of the actual audio
 * being mono or stereo -- the real channel count is signaled separately via
 * the `stereo`/`sprop-stereo` fmtp parameters. Browsers (Chrome confirmed)
 * enforce this strictly: a `/1` rtpmap is not recognized as Opus at all,
 * causing the answer to fall back to PCMU (which isn't in this codec list)
 * and negotiation to fail outright. `stereo=0;sprop-stereo=0` below is the
 * correct, spec-compliant way to say "this stream is actually mono" while
 * still satisfying the required `/2`. This is SDP-declaration only -- the
 * actual audio is still encoded mono by ffmpeg's `-ac 1`.
 */
export const AUDIO_CODEC = new RTCRtpCodecParameters({
  mimeType: "audio/opus",
  clockRate: 48000,
  channels: 2,
  payloadType: 111,
  parameters: "minptime=10;useinbandfec=1;stereo=0;sprop-stereo=0",
});
