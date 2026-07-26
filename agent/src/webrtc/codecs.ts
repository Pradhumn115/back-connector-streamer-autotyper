import { RTCRtpCodecParameters } from "werift";

/**
 * H264 constrained-baseline (profile-level-id 42e03c), packetization-mode 1 —
 * the combination every Chromium/Firefox/Safari WebRTC stack accepts, and what
 * ffmpeg's libx264 with `-profile:v baseline -level 6.0` produces.
 *
 * The level byte (the last two hex digits) MUST match the `-level` flag given
 * to ffmpeg in index.ts's webrtcFfmpegArgs.video. Level 3.1 (hex 1f) was
 * tried first but its 108,000 MB/s macroblock-rate limit is well below what's
 * needed to encode a real screen capture — libx264 doesn't error out on this,
 * it just warns and hangs forever without ever emitting RTP output. Level 4.0
 * (hex 28) fixed that for 30fps but its 245,760 MB/s macroblock-rate budget
 * caps far short of 120fps at real capture resolutions. Level 5.1 (hex 33)
 * was tried next but this machine's actual native avfoundation capture
 * resolution — 3456x2234 (Retina/HiDPI), not a smaller reference case — needs
 * ceil(3456/16) x ceil(2234/16) = 216 x 140 = 30,240 MB/frame, and at 120fps
 * that's 30,240 x 120 = 3,628,800 MB/s, which *exceeds* level 5.1's 983,040
 * MB/s MaxMBPS budget by ~3.7x (libx264 printed `MB rate (3628800) > level
 * limit (983040)` and encoded anyway, but the SDP would have declared a level
 * the stream doesn't actually conform to).
 *
 * Level 6.0 (decimal level_idc 60 -> hex 3c; 60 = 3*16 + 12 = 0x3c) raises
 * MaxMBPS to 4,177,920 MB/s, comfortably covering the 3,628,800 MB/s required
 * at 3456x2234@120fps (~15% margin) and MaxFS to 139,264 MB (far above the
 * 30,240 MB/frame needed), while remaining a level every modern WebRTC
 * decoder supports. Since this app controls both the offering/encoding side
 * and the SDP declaration, there's no compatibility downside to using it.
 * This was verified empirically (not just via the level-limits arithmetic) by
 * running the exact ffmpeg command index.ts constructs — targeting this
 * machine's real native 3456x2234 capture resolution, no `-vf scale` — against
 * a UDP listener at `-loglevel info`/`-stats` and confirming both real RTP
 * packets flow at a genuine (speed=1x) 120fps AND that the `MB rate > level
 * limit` warning is gone at level 6.0 — see index.ts's -level comment and the
 * task11 fix report for the packet counts and full ffmpeg output observed.
 */
export const VIDEO_CODEC = new RTCRtpCodecParameters({
  mimeType: "video/H264",
  clockRate: 90000,
  payloadType: 96,
  parameters: "profile-level-id=42e03c;packetization-mode=1;level-asymmetry-allowed=1",
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
