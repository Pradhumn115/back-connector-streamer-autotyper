import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMacBlackHoleIndex, parseWindowsLoopbackName } from "./detect.js";

const MAC_LIST = `[AVFoundation indev @ 0x1] AVFoundation video devices:
[AVFoundation indev @ 0x1] [0] FaceTime HD Camera
[AVFoundation indev @ 0x1] [1] Capture screen 0
[AVFoundation indev @ 0x1] AVFoundation audio devices:
[AVFoundation indev @ 0x1] [0] BlackHole 2ch
[AVFoundation indev @ 0x1] [1] MacBook Pro Microphone`;

test("mac: finds BlackHole audio index, not confused by video [n] indices", () => {
  assert.equal(parseMacBlackHoleIndex(MAC_LIST), "0");
});

test("mac: returns null when BlackHole isn't present", () => {
  const noBlackHole = MAC_LIST.replace("BlackHole 2ch", "External Headphones");
  assert.equal(parseMacBlackHoleIndex(noBlackHole), null);
});

test("mac: ignores a device literally named BlackHole in the VIDEO section", () => {
  const trap = `[AVFoundation indev @ 0x1] AVFoundation video devices:
[AVFoundation indev @ 0x1] [0] BlackHole Camera
[AVFoundation indev @ 0x1] AVFoundation audio devices:
[AVFoundation indev @ 0x1] [0] MacBook Pro Microphone`;
  assert.equal(parseMacBlackHoleIndex(trap), null);
});

const WIN_LIST = `[dshow @ 0x1] DirectShow video devices
[dshow @ 0x1]  "Integrated Camera"
[dshow @ 0x1] DirectShow audio devices
[dshow @ 0x1]  "Microphone (Realtek Audio)"
[dshow @ 0x1]  "CABLE Output (VB-Audio Virtual Cable)"`;

test("win: finds the VB-Cable output device name", () => {
  assert.equal(
    parseWindowsLoopbackName(WIN_LIST),
    "CABLE Output (VB-Audio Virtual Cable)",
  );
});

test("win: finds virtual-audio-capturer", () => {
  const list = `[dshow @ 0x1] DirectShow audio devices
[dshow @ 0x1]  "virtual-audio-capturer"`;
  assert.equal(parseWindowsLoopbackName(list), "virtual-audio-capturer");
});

test("win: returns null when only a normal mic is present", () => {
  const list = `[dshow @ 0x1] DirectShow audio devices
[dshow @ 0x1]  "Microphone (Realtek Audio)"`;
  assert.equal(parseWindowsLoopbackName(list), null);
});

test("win: finds VB-Cable A+B pack's CABLE-A/CABLE-B Output", () => {
  const list = `[dshow @ 0x1] DirectShow audio devices
[dshow @ 0x1]  "Microphone (Realtek Audio)"
[dshow @ 0x1]  "CABLE-A Output (VB-Audio Cable A)"`;
  assert.equal(parseWindowsLoopbackName(list), "CABLE-A Output (VB-Audio Cable A)");
});

test("win: finds VoiceMeeter's virtual output", () => {
  const list = `[dshow @ 0x1] DirectShow audio devices
[dshow @ 0x1]  "VoiceMeeter Output (VB-Audio VoiceMeeter VAIO)"`;
  assert.equal(
    parseWindowsLoopbackName(list),
    "VoiceMeeter Output (VB-Audio VoiceMeeter VAIO)",
  );
});

test("win: finds the built-in Stereo Mix device", () => {
  const list = `[dshow @ 0x1] DirectShow audio devices
[dshow @ 0x1]  "Stereo Mix (Realtek Audio)"`;
  assert.equal(parseWindowsLoopbackName(list), "Stereo Mix (Realtek Audio)");
});

test("win: skips the Alternative name line, doesn't misread it as the device name", () => {
  const list = `[dshow @ 0x1] DirectShow audio devices
[dshow @ 0x1]  "CABLE Output (VB-Audio Virtual Cable)"
[dshow @ 0x1]     Alternative name "@device_cm_ip_true_pin:{05BAB6}\\wave:{CABLE}"
[dshow @ 0x1]  "Microphone (Realtek Audio)"`;
  assert.equal(
    parseWindowsLoopbackName(list),
    "CABLE Output (VB-Audio Virtual Cable)",
  );
});

test("win: finds CABLE Output in the newer no-section-headers ffmpeg format", () => {
  // Verbatim (trimmed) output from a real N-120858 nightly ffmpeg build on
  // Windows -- no "DirectShow audio/video devices" headers at all, each
  // device tagged inline with "(audio)"/"(video)" instead.
  const list = String.raw`[dshow @ 000002a3485f0480] "Integrated Camera" (video)
[dshow @ 000002a3485f0480]   Alternative name "@device_pnp_\\?\usb#vid_5986&pid_215d&mi_00#6&2b7db935&1&0000#{65e8773d-8f56-11d0-a3b9-00a0c9223196}\global"
[dshow @ 000002a3485f0480] "CABLE Output (VB-Audio Virtual Cable)" (audio)
[dshow @ 000002a3485f0480]   Alternative name "@device_cm_{33D9A762-90C8-11D0-BD43-00A0C911CE86}\wave_{B67E7940-B840-46CB-975C-F921DCB89346}"
[dshow @ 000002a3485f0480] "Microphone (Senary Audio)" (audio)
[dshow @ 000002a3485f0480]   Alternative name "@device_cm_{33D9A762-90C8-11D0-BD43-00A0C911CE86}\wave_{4D4568B3-6047-46F2-942B-70411D412B75}"
[dshow @ 000002a3485f0480] "Microphone Array (Senary Audio)" (audio)
[dshow @ 000002a3485f0480]   Alternative name "@device_cm_{33D9A762-90C8-11D0-BD43-00A0C911CE86}\wave_{F169B923-6631-4F24-8167-A66D47CDD9DE}"`;
  assert.equal(parseWindowsLoopbackName(list), "CABLE Output (VB-Audio Virtual Cable)");
});

test("win: newer format doesn't pick an audio-only device tagged (video) by mistake", () => {
  const list = `[dshow @ 0x1] "CABLE Output (VB-Audio Virtual Cable)" (video)
[dshow @ 0x1] "Microphone (Realtek Audio)" (audio)`;
  assert.equal(parseWindowsLoopbackName(list), null);
});
