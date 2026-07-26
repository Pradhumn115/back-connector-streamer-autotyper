import { RTCRtpCodecParameters } from "werift";

/**
 * H264 constrained-baseline (profile-level-id 42e01f), packetization-mode 1 —
 * the combination every Chromium/Firefox/Safari WebRTC stack accepts, and what
 * ffmpeg's libx264 with `-profile:v baseline -level 3.1` produces.
 */
export const VIDEO_CODEC = new RTCRtpCodecParameters({
  mimeType: "video/H264",
  clockRate: 90000,
  payloadType: 96,
  parameters: "profile-level-id=42e01f;packetization-mode=1;level-asymmetry-allowed=1",
  rtcpFeedback: [
    { type: "ccm", parameter: "fir" },
    { type: "nack" },
    { type: "nack", parameter: "pli" },
    { type: "goog-remb" },
  ],
});

/** Opus mono at 48 kHz — matches ffmpeg's libopus default and browser decode. */
export const AUDIO_CODEC = new RTCRtpCodecParameters({
  mimeType: "audio/opus",
  clockRate: 48000,
  channels: 1,
  payloadType: 111,
});
