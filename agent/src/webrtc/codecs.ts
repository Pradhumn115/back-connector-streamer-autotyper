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
   * Value for ffmpeg's `-x264-params`, which must make the encoder actually
   * emit `ffmpegProfile` -- `-profile:v` alone does NOT guarantee it.
   *
   * `-profile:v` is a CEILING, not a floor: it forbids tools above the named
   * profile but never enables any. `-preset ultrafast` disables CABAC and the
   * 8x8 transform, so the bitstream uses nothing above Constrained Baseline
   * and x264 writes profile_idc=66 into the SPS accordingly -- even when asked
   * for High. Measured: ultrafast alone gives "Constrained Baseline", and
   * ultrafast plus `cabac=1:8x8dct=1` gives "High".
   *
   * That mismatch is not cosmetic. The SDP offer advertises this tier's
   * profile-level-id; the browser negotiates a decoder on that promise and
   * then receives a stream whose SPS declares a different profile, so it
   * rejects every frame and asks for a keyframe forever against a blank
   * <video>. It broke identically on every OS, because it is purely an
   * encoder-settings bug with nothing platform-specific about it.
   *
   * Also carries `sliced-threads=0`; see the encoder args in index.ts.
   */
  x264Params: string;
  /**
   * Resolution cap (pixels wide) for this tier's ffmpeg encode, or `null`
   * for native/uncapped. Mirrors Classic capture's own `maxWidth` pattern
   * (see capture/ffmpeg.ts) via `-vf fps=N,scale='min(W,iw)':-2`.
   */
  maxWidth: number | null;
  /** fps cap for this tier's ffmpeg encode. */
  maxFps: number;
  /**
   * Hard ceiling on macroblocks per frame, already reduced to also satisfy the
   * level's macroblock-RATE limit at `maxFps`: `min(MaxFS, MaxMBPS / maxFps)`.
   *
   * A width cap cannot express this, and assuming it could is what broke
   * decoding on a non-16:9 display. `maxWidth: 1280` was picked because
   * 1280x720 is exactly level 3.1's 3600-macroblock budget -- but only at 16:9.
   * On a 3456x2234 (~1.55:1) Retina desktop, 1280 wide becomes 1280x832, i.e.
   * 80x52 = 4160 macroblocks, and libx264 says so plainly:
   *
   *   frame MB size (80x52) > level limit (3600)
   *   MB rate (124800) > level limit (108000)
   *
   * x264 does not raise the level in response -- it warns and still writes the
   * requested level into the SPS. So the browser negotiates level 3.1, receives
   * a stream that violates level 3.1, and rejects every frame: the same blank
   * <video> and endless keyframe requests as a profile mismatch. The real
   * constraint is on AREA, which is what buildVideoFilter now bounds.
   */
  maxMacroblocks: number;
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
  // CABAC and the 8x8 transform are what make this stream genuinely High
  // profile rather than Constrained Baseline wearing a High label -- see
  // VideoCodecTier.x264Params.
  x264Params: "sliced-threads=0:cabac=1:8x8dct=1",
  // Capped rather than native.
  //
  // This tier used to run uncapped, which on a Retina display means encoding
  // 3456x2234 at 60fps. Measured against the real screen device, that ran at
  // speed=0.991x single-threaded -- i.e. exactly keeping up, with no margin
  // for a busy moment -- before CABAC was added, and CABAC is not free. At
  // 1920 the same encode leaves roughly 74% headroom, which is what makes an
  // honest High-profile stream affordable at all.
  //
  // 1920 also matches Classic's own default cap (see index.ts's maxWidth), so
  // the two transports no longer disagree about how much detail is worth
  // sending, and 1920x1240@60 sits far inside level 5.2's limits.
  maxWidth: 1920,
  maxFps: 60,
  // Level 5.2: MaxFS=36864, MaxMBPS=2,073,600. At 60fps the rate limit binds
  // first: 2,073,600 / 60 = 34,560. The 1920 width cap is what actually
  // governs here (1920x1240 is only 9,360 MB); this is the backstop.
  maxMacroblocks: 34560,
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
  // Deliberately NO cabac/8x8dct here, unlike the High tier: Baseline forbids
  // both, so enabling them would push the bitstream above the profile this
  // tier advertises -- the same class of mismatch, in the other direction.
  // `-preset ultrafast` already produces exactly Constrained Baseline, so this
  // tier's declared and actual profiles agree with no extra tools.
  x264Params: "sliced-threads=0",
  maxWidth: 1280,
  maxFps: 30,
  // Level 3.1: MaxFS=3600, MaxMBPS=108,000. At 30fps both bind at exactly
  // 3600, which is 1280x720 -- and ONLY at 16:9, which is precisely why the
  // width cap alone was not enough on a 1.55:1 display.
  maxMacroblocks: 3600,
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
