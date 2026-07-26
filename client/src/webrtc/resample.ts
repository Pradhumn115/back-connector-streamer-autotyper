const TARGET_RATE = 16000;

/**
 * Downmix interleaved multi-channel audio to mono (average of channels), then
 * linearly resample to 16 kHz — Whisper's native input rate. WebRTC audio
 * tracks commonly decode at 48 kHz; this makes the WebRTC transcription tap
 * produce the exact shape the existing (unmodified) transcription pipeline
 * expects from pushFrame.
 */
export function resampleTo16kMono(
  input: Float32Array,
  inputRate: number,
  inputChannels: number,
): Float32Array {
  const frames = Math.floor(input.length / inputChannels);
  const mono = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < inputChannels; c++) sum += input[i * inputChannels + c];
    mono[i] = sum / inputChannels;
  }
  if (inputRate === TARGET_RATE) return mono;

  const outLength = Math.round((mono.length * TARGET_RATE) / inputRate);
  const out = new Float32Array(outLength);
  const ratio = mono.length / outLength;
  for (let i = 0; i < outLength; i++) {
    const srcPos = i * ratio;
    const i0 = Math.floor(srcPos);
    const i1 = Math.min(mono.length - 1, i0 + 1);
    const frac = srcPos - i0;
    out[i] = mono[i0] * (1 - frac) + mono[i1] * frac;
  }
  return out;
}
