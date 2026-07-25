/**
 * Lightweight energy-based voice-activity detection plus small audio helpers.
 *
 * We segment audio into speech runs and feed only those to Whisper, so silence
 * never reaches the model — which is what makes Whisper hallucinate "you"/"thank
 * you" on quiet gaps — and utterances split on real pauses instead of arbitrary
 * windows.
 *
 * This is deliberately model-free (RMS over short frames). A neural VAD like
 * Silero is more robust at rejecting music/noise as non-speech, but its ONNX
 * weights don't load reliably under every bundler; this pure approach always
 * works, needs no download, and is enough to strip the silence that causes the
 * hallucinations. Threshold is relative to the clip's own peak, so it adapts to
 * loud and quiet sources.
 */

export interface SpeechSegment {
  /** Trimmed speech audio (Float32, same sample rate as the input). */
  audio: Float32Array;
}

const FRAME_S = 0.03; // 30 ms analysis frames
const MIN_SPEECH_S = 0.15; // ignore blips shorter than this
const MAX_GAP_S = 0.3; // bridge pauses shorter than this (keep words together)
const PAD_S = 0.1; // keep a little context around each segment
const ABS_FLOOR = 0.012; // never treat anything below this RMS as speech
const PEAK_FRACTION = 0.08; // speech threshold = max(ABS_FLOOR, peak * this)

/**
 * Split a mono Float32 buffer into speech segments, trimming silence. Returns []
 * when the buffer is silent (nothing to transcribe).
 */
export function segmentSpeech(audio: Float32Array, sampleRate = 16000): SpeechSegment[] {
  const frameLen = Math.max(1, Math.round(sampleRate * FRAME_S));
  const nFrames = Math.floor(audio.length / frameLen);
  if (nFrames === 0) return audio.length ? [{ audio }] : [];

  // Per-frame RMS + peak.
  const rms = new Float32Array(nFrames);
  let peak = 0;
  for (let f = 0; f < nFrames; f++) {
    let sum = 0;
    const off = f * frameLen;
    for (let i = 0; i < frameLen; i++) {
      const v = audio[off + i];
      sum += v * v;
    }
    const r = Math.sqrt(sum / frameLen);
    rms[f] = r;
    if (r > peak) peak = r;
  }

  const threshold = Math.max(ABS_FLOOR, peak * PEAK_FRACTION);
  const maxGap = Math.round(MAX_GAP_S / FRAME_S);
  const minSpeech = Math.round(MIN_SPEECH_S / FRAME_S);
  const pad = Math.round(PAD_S / FRAME_S);

  // Raw runs of speech frames.
  const runs: Array<[number, number]> = [];
  let f = 0;
  while (f < nFrames) {
    if (rms[f] >= threshold) {
      let e = f;
      while (e < nFrames && rms[e] >= threshold) e++;
      runs.push([f, e]);
      f = e;
    } else {
      f++;
    }
  }

  // Merge runs separated by a short gap so words aren't split.
  const merged: Array<[number, number]> = [];
  for (const [s, e] of runs) {
    const last = merged[merged.length - 1];
    if (last && s - last[1] <= maxGap) last[1] = e;
    else merged.push([s, e]);
  }

  // Drop too-short runs, pad, and slice out the audio.
  const segments: SpeechSegment[] = [];
  for (const [s, e] of merged) {
    if (e - s < minSpeech) continue;
    const startF = Math.max(0, s - pad);
    const endF = Math.min(nFrames, e + pad);
    segments.push({
      audio: audio.slice(startF * frameLen, Math.min(audio.length, endF * frameLen)),
    });
  }
  return segments;
}

/** Concatenate Float32 chunks into one contiguous buffer. */
export function concatFloat32(chunks: Float32Array[]): Float32Array {
  let len = 0;
  for (const c of chunks) len += c.length;
  const out = new Float32Array(len);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/**
 * RMS amplitude of the last `tailSamples` of the buffer. The live loop uses this
 * to detect a trailing pause (the speaker stopped) and flush the utterance.
 */
export function tailRms(audio: Float32Array, tailSamples: number): number {
  const n = Math.min(Math.floor(tailSamples), audio.length);
  if (n <= 0) return 0;
  let sum = 0;
  for (let i = audio.length - n; i < audio.length; i++) sum += audio[i] * audio[i];
  return Math.sqrt(sum / n);
}
