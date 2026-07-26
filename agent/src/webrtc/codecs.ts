import { RTCRtpCodecParameters } from "werift";

/**
 * H264 High profile, Level 5.2 (profile-level-id 640034), packetization-mode 1.
 *
 * Every earlier round of this fix (levels 3.1 -> 4.0 -> 5.1 -> 6.0) tuned the
 * macroblock-rate budget against libx264's own encode-side leniency (it warns
 * but still emits packets when nominally over budget) without ever checking
 * whether a REAL WebRTC decoder — Chrome — actually supports the declared
 * profile/level at all. It doesn't: querying Chrome's own capability API
 * directly,
 *
 *   RTCRtpSender.getCapabilities('video').codecs
 *     .filter(c => c.mimeType === 'video/H264').map(c => c.sdpFmtpLine)
 *
 * returns exactly seven H.264 variants, none above level 5.2, and NONE at
 * level 6.0 in any profile. Since the previous SDP offer declared
 * profile-level-id=42e03c (Constrained Baseline, level 6.0) — a combination
 * Chrome has never heard of — Chrome's answer always came back with zero
 * codecs for the video m-line and werift's setRemoteDescription() threw
 * "negotiate codecs failed." every time. This was a hard, deterministic
 * negotiation failure, not a resource/hang issue like the earlier rounds.
 *
 * profile-level-id=640034 is the highest level+profile combination Chrome's
 * capabilities list actually contains: profile_idc 0x64 = High profile,
 * profile_iop 0x00 = no constraint flags set, level_idc 0x34 = 52 decimal =
 * level 5.2 (52 = 3*16 + 4 = 0x34). The level byte (the last two hex digits)
 * MUST match the `-level` flag given to ffmpeg in index.ts's
 * webrtcFfmpegArgs.video, and the profile byte must match `-profile:v`.
 *
 * Level 5.2's MaxMBPS is 2,073,600 MB/s. This machine's real native
 * avfoundation capture resolution — 3456x2234 (Retina/HiDPI) — needs
 * ceil(3456/16) x ceil(2234/16) = 216 x 140 = 30,240 MB/frame, and at 120fps
 * that's 30,240 x 120 = 3,628,800 MB/s, which nominally exceeds level 5.2's
 * budget by ~1.75x. As with the earlier over-budget levels, libx264 encodes
 * anyway and only prints an advisory `MB rate > level limit` warning — but
 * unlike the earlier rounds, this was NOT taken on faith: real-Chrome
 * empirical testing (see index.ts's -level comment and the task11 fix
 * report) confirmed both that negotiation now succeeds and that Chrome's
 * decoder actually decodes real, increasing frames at the fps this app
 * settled on for WebRTC — see MAX_WEBRTC_FPS in index.ts for the ceiling
 * that was found safe and why.
 */
export const VIDEO_CODEC = new RTCRtpCodecParameters({
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
