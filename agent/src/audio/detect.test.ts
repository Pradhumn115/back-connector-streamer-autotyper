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
