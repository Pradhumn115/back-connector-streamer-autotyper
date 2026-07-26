import { RTCRtpCodecParameters } from "werift";

/**
 * H264 constrained-baseline (profile-level-id 42e028), packetization-mode 1 —
 * the combination every Chromium/Firefox/Safari WebRTC stack accepts, and what
 * ffmpeg's libx264 with `-profile:v baseline -level 4.0` produces.
 *
 * The level byte (the last two hex digits) MUST match the `-level` flag given
 * to ffmpeg in index.ts's webrtcFfmpegArgs.video. Level 3.1 (hex 1f) was
 * tried first but its 108,000 MB/s macroblock-rate limit is well below what's
 * needed to encode a real screen capture (e.g. 1728x1117@30fps) — libx264
 * doesn't error out on this, it just warns and hangs forever without ever
 * emitting RTP output. Level 4.0 (decimal level_idc 40 -> hex 28) comfortably
 * covers 1080p-class resolutions and is universally supported by WebRTC
 * decoders, and since this app controls both the offering/encoding side and
 * the SDP declaration, there's no compatibility downside to using it.
 */
export const VIDEO_CODEC = new RTCRtpCodecParameters({
  mimeType: "video/H264",
  clockRate: 90000,
  payloadType: 96,
  parameters: "profile-level-id=42e028;packetization-mode=1;level-asymmetry-allowed=1",
  rtcpFeedback: [
    { type: "ccm", parameter: "fir" },
    { type: "nack" },
    { type: "nack", parameter: "pli" },
    { type: "goog-remb" },
  ],
});

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
