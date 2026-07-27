import { float32ToPcmS16 } from "./pcm";

/** Byte size of a canonical WAV header (RIFF + fmt chunk + data chunk header). */
const HEADER_BYTES = 44;

/**
 * Wrap Float32 samples in a minimal 16-bit PCM WAV container, so a recorded
 * take can be played back in an <audio> element.
 *
 * The pipeline's audio is already mono at a known sample rate (the agent
 * guarantees 16 kHz mono), so this
 * only ever writes single-channel PCM — enough for playback and for saving
 * a take to disk, without pulling in an encoder dependency.
 */
export function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const pcm = float32ToPcmS16(samples);
  const buffer = new ArrayBuffer(HEADER_BYTES + pcm.byteLength);
  const view = new DataView(buffer);

  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  const channels = 1;
  const bitsPerSample = 16;
  const blockAlign = (channels * bitsPerSample) / 8;

  writeAscii(0, "RIFF");
  // RIFF chunk size counts everything after this field, i.e. total - 8.
  view.setUint32(4, HEADER_BYTES - 8 + pcm.byteLength, true);
  writeAscii(8, "WAVE");

  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk body size (16 = PCM, no extensions)
  view.setUint16(20, 1, true); // format 1 = uncompressed PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true); // byte rate
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);

  writeAscii(36, "data");
  view.setUint32(40, pcm.byteLength, true);
  new Uint8Array(buffer, HEADER_BYTES).set(pcm);

  return new Blob([buffer], { type: "audio/wav" });
}
