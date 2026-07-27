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
 * ## What browsers actually accept
 *
 * Measured with `RTCRtpReceiver.getCapabilities("video")` in each engine —
 * the RECEIVE list, which is what negotiation uses. (The send list is not the
 * same, and reading the send list is how this file previously ended up
 * offering a tier no browser would take.)
 *
 *   Chromium: H.264 42001f, 42e01f, 4d001f, f4001f — every one at level 1f
 *             (3.1). Plus VP8, VP9, AV1.
 *   WebKit:   H.264 640c1f, 42e01f — again level 1f only. Plus VP8, VP9, AV1.
 *   Firefox:  NO H.264 whatsoever. VP8, VP9, AV1 only.
 *
 * Two conclusions drive the tiers below. Constrained Baseline at level 3.1
 * (42e01f) is the only H.264 combination every H.264-capable engine lists, and
 * no engine advertises a level above 3.1 for receiving. And H.264 alone cannot
 * reach Firefox at all, because there it comes from a separately downloaded
 * OpenH264 plugin that is frequently absent or disabled — which is exactly how
 * Firefox was observed negotiating an audio-only session against this agent.
 */
export interface VideoCodecTier {
  codec: RTCRtpCodecParameters;
  /** Short human label, used in logs and test names. */
  label: string;
  /**
   * ffmpeg encoder selection and tuning: everything from `-c:v` up to the
   * bitrate/GOP flags that index.ts applies to every tier alike.
   *
   * Codec-specific rather than a set of H.264 fields, because VP8 has no
   * profile, no level, and no x264 parameters — modelling those as tier
   * properties only worked while every tier happened to be H.264.
   *
   * For the H.264 tier this must include whatever makes the encoder emit the
   * profile its SDP advertises. `-profile:v` is a CEILING, not a floor: it
   * forbids tools above the named profile but enables none, so `-preset
   * ultrafast` (which disables CABAC and the 8x8 transform) yields a bitstream
   * using nothing above Constrained Baseline, and x264 writes profile_idc
   * accordingly. A browser that negotiates one profile and receives another
   * rejects every frame.
   */
  encoderArgs: string[];
  /**
   * Resolution cap (pixels wide) for this tier's ffmpeg encode, or `null`
   * for native/uncapped. Mirrors Classic capture's own `maxWidth` pattern
   * (see capture/ffmpeg.ts).
   */
  maxWidth: number | null;
  /** fps cap for this tier's ffmpeg encode. */
  maxFps: number;
  /**
   * The level's macroblock ceiling, already reduced to also satisfy its
   * macroblock-RATE limit at `maxFps` (`min(MaxFS, MaxMBPS / maxFps)`), or
   * `null` for a codec with no such limit.
   *
   * A width cap cannot express this. `maxWidth: 1280` matched level 3.1's
   * 3600-macroblock budget only at 16:9; on a 3456x2234 (~1.55:1) desktop the
   * same cap produced 1280x832 = 80x52 = 4160 macroblocks, and libx264 said so:
   *
   *   frame MB size (80x52) > level limit (3600)
   *   MB rate (124800) > level limit (108000)
   *
   * x264 does not raise the level in response — it warns and still writes the
   * requested level into the SPS, so the browser negotiates level 3.1, receives
   * a stream violating level 3.1, and rejects every frame. The constraint is on
   * AREA, which is what buildVideoFilter bounds.
   */
  maxMacroblocks: number | null;
  /**
   * Bitrate ceiling for this tier's encode, in kbit/s, applied as
   * `-b:v`/`-maxrate` with a half-size `-bufsize`.
   *
   * Not cosmetic: without an explicit rate cap libx264 encodes at its default
   * CRF, which on a desktop at high fps produces bursts of tens of Mbit/s, and
   * libvpx defaults to a bitrate low enough to look broken. Nothing in this
   * pipeline reacts to congestion — the `goog-remb` feedback advertised below
   * is negotiated but never read — so an uncapped encoder simply overruns the
   * link.
   */
  maxBitrateKbps: number;
}

/** RTCP feedback offered on every video tier. */
const VIDEO_RTCP_FEEDBACK = [
  { type: "ccm", parameter: "fir" },
  { type: "nack" },
  { type: "nack", parameter: "pli" },
  { type: "goog-remb" },
];

/**
 * Constrained Baseline, Level 3.1 (profile-level-id 42e01f),
 * packetization-mode 1 — the WebRTC "mandatory to implement" H.264
 * combination, and per the capability probe above the only one both Chromium
 * and WebKit actually list for receiving.
 *
 * Constrained Baseline forbids B-frames (no reference-frame buffering, so no
 * added latency) and has the broadest hardware-decode support of any H.264
 * profile. Preferred over VP8 below because that hardware decode is real:
 * where H.264 is available it costs the client far less battery and CPU.
 *
 * Level 3.1's budget (MaxFS=3600 MB, MaxMBPS=108,000) is exactly 1280x720 at
 * 30fps — but ONLY at 16:9, hence maxMacroblocks rather than trusting the
 * width cap alone.
 */
export const VIDEO_CODEC_BASELINE: VideoCodecTier = {
  codec: new RTCRtpCodecParameters({
    mimeType: "video/H264",
    clockRate: 90000,
    payloadType: 97,
    parameters: "profile-level-id=42e01f;packetization-mode=1;level-asymmetry-allowed=1",
    rtcpFeedback: VIDEO_RTCP_FEEDBACK,
  }),
  label: "h264-baseline-3.1",
  encoderArgs: [
    "-c:v", "libx264",
    "-profile:v", "baseline",
    "-level", "3.1",
    "-preset", "ultrafast",
    "-tune", "zerolatency",
    // One slice per frame. `-tune zerolatency` enables x264's sliced-threads,
    // splitting each frame into one slice per worker thread; measured, that
    // produced ~8 slices per frame, and browser WebRTC decoders do not decode
    // multi-slice frames reliably. `-threads 1` rather than sliced-threads=0
    // alone because with slicing off but several threads x264 switches to
    // FRAME threading, which costs a delay of `threads` frames — around 130ms
    // at 60fps, which a remote desktop cannot spend.
    "-threads", "1",
    // Deliberately NO cabac/8x8dct: Baseline forbids both, and enabling them
    // would push the bitstream above the profile this tier advertises.
    "-x264-params", "sliced-threads=0",
  ],
  maxWidth: 1280,
  maxFps: 30,
  maxMacroblocks: 3600,
  maxBitrateKbps: 2500,
};

/**
 * VP8 — the universal fallback, and the only tier Firefox can take.
 *
 * VP8 is mandatory to implement for every WebRTC endpoint, and unlike H.264 it
 * has no profile and no level, so there is nothing to mis-negotiate: the whole
 * class of bugs that made this transport ship undecodable (a profile the SDP
 * did not match, a frame size violating the negotiated level) cannot occur
 * here. It is listed last because it is worth strictly less than H.264 where
 * H.264 exists — libvpx is software-only on the agent, and clients that
 * advertise H.264 get hardware decode from it.
 *
 * Offering it is what makes the "works from any machine to any machine" claim
 * true rather than aspirational: without it, any browser lacking an H.264
 * decoder negotiates an audio-only session and renders nothing.
 */
export const VIDEO_CODEC_VP8: VideoCodecTier = {
  codec: new RTCRtpCodecParameters({
    mimeType: "video/VP8",
    clockRate: 90000,
    payloadType: 98,
    rtcpFeedback: VIDEO_RTCP_FEEDBACK,
  }),
  label: "vp8",
  encoderArgs: [
    "-c:v", "libvpx",
    // libvpx's quality/speed control. `realtime` plus the fastest cpu-used
    // step is the only combination that keeps up with live screen capture;
    // the default (`good`) is far too slow and silently falls behind.
    "-deadline", "realtime",
    "-cpu-used", "8",
    // No lookahead and no alternate reference frames: both buffer future
    // frames before emitting one, which is latency this cannot spend.
    "-lag-in-frames", "0",
    "-auto-alt-ref", "0",
    // Makes each frame independently recoverable enough that loss degrades
    // rather than wedging the decoder until the next keyframe.
    "-error-resilient", "1",
  ],
  // VP8 has no level, so nothing constrains frame area — but software encoding
  // does. These match the H.264 tier rather than exceeding it, since a client
  // on this path is by definition one whose decode is also software.
  maxWidth: 1280,
  maxFps: 30,
  maxMacroblocks: null,
  maxBitrateKbps: 2500,
};

/**
 * Offered in preference order: hardware-friendly H.264 first, then VP8 as the
 * universal fallback. The offerer's order is what most browsers use to break
 * ties, so Chromium and WebKit take H.264 and Firefox falls through to VP8.
 *
 * A High-profile/Level-5.2 tier (640034) used to lead this list. It was
 * removed rather than repaired: the capability probe documented on
 * VideoCodecTier shows no engine advertises High for receiving, and none
 * advertises any level above 3.1, so it could never be selected. Every
 * session that ever worked landed on the baseline tier regardless.
 */
export const VIDEO_CODEC_TIERS: VideoCodecTier[] = [VIDEO_CODEC_BASELINE, VIDEO_CODEC_VP8];

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

/**
 * The tiers to offer for a client's stated codec preference.
 *
 * "auto" offers everything and lets the browser choose — normally the right
 * answer, since negotiation is answerer's-choice and a browser knows its own
 * decoders. Pinning a codec narrows the offer to one family, which is useful
 * both as an escape hatch (a client whose H.264 decoder is present but broken)
 * and as a diagnostic (a blank picture on "auto" that works on "vp8" localises
 * the fault immediately).
 *
 * An unsatisfiable preference yields an empty list rather than silently
 * falling back to something the caller did not ask for: the caller reports
 * that as a real error, which is far easier to act on than a session that
 * quietly ignores the request.
 */
export function tiersForPreference(preference: "auto" | "h264" | "vp8"): VideoCodecTier[] {
  switch (preference) {
    case "h264":
      return VIDEO_CODEC_TIERS.filter((t) => t.codec.mimeType === "video/H264");
    case "vp8":
      return VIDEO_CODEC_TIERS.filter((t) => t.codec.mimeType === "video/VP8");
    default:
      return VIDEO_CODEC_TIERS;
  }
}
