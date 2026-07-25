/**
 * Binary frame wire format for audio chunks (agent -> client).
 *
 * Separate from the video frame (frame.ts) but shares the same WebSocket: the
 * two are told apart by their magic number, so the client routes a binary
 * message to video vs audio with a cheap check (isFrame vs isAudioFrame).
 *
 * The payload is raw interleaved PCM. For this app the agent always sends
 * 16 kHz mono signed 16-bit little-endian (Whisper's native input), but the
 * sample rate / channels / format travel in the header so the client is never
 * hard-coded to one shape.
 *
 * Layout (little-endian):
 *   offset 0 : uint32  magic      = 0x42434146 ("BCAF")
 *   offset 4 : uint32  seq        (monotonic chunk sequence number)
 *   offset 8 : float64 timestamp  (ms since epoch on the agent)
 *   offset 16: uint32  sampleRate (Hz, e.g. 16000)
 *   offset 20: uint8   channels   (e.g. 1)
 *   offset 21: uint8   format     (0 = PCM s16le)
 *   offset 22: uint16  reserved   (0)
 *   offset 24: ...      PCM payload bytes
 */

export const AUDIO_FRAME_MAGIC = 0x42434146;
export const AUDIO_FRAME_HEADER_SIZE = 24;

export enum AudioFormat {
  PCM_S16LE = 0,
}

export interface DecodedAudioFrame {
  seq: number;
  timestamp: number;
  sampleRate: number;
  channels: number;
  format: AudioFormat;
  payload: Uint8Array;
}

/** Encode an audio chunk into a single ArrayBuffer suitable for ws.send(). */
export function encodeAudioFrame(
  seq: number,
  timestamp: number,
  sampleRate: number,
  channels: number,
  format: AudioFormat,
  payload: Uint8Array,
): ArrayBuffer {
  const buf = new ArrayBuffer(AUDIO_FRAME_HEADER_SIZE + payload.byteLength);
  const view = new DataView(buf);
  view.setUint32(0, AUDIO_FRAME_MAGIC, true);
  view.setUint32(4, seq >>> 0, true);
  view.setFloat64(8, timestamp, true);
  view.setUint32(16, sampleRate >>> 0, true);
  view.setUint8(20, channels);
  view.setUint8(21, format);
  view.setUint16(22, 0, true);
  new Uint8Array(buf, AUDIO_FRAME_HEADER_SIZE).set(payload);
  return buf;
}

/** Decode a binary audio frame. Returns null if it isn't a valid audio frame. */
export function decodeAudioFrame(data: ArrayBuffer | Uint8Array): DecodedAudioFrame | null {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.byteLength < AUDIO_FRAME_HEADER_SIZE) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== AUDIO_FRAME_MAGIC) return null;
  const seq = view.getUint32(4, true);
  const timestamp = view.getFloat64(8, true);
  const sampleRate = view.getUint32(16, true);
  const channels = view.getUint8(20);
  const format = view.getUint8(21) as AudioFormat;
  const payload = bytes.subarray(AUDIO_FRAME_HEADER_SIZE);
  return { seq, timestamp, sampleRate, channels, format, payload };
}

/** True if a binary buffer looks like one of our audio frames (cheap magic check). */
export function isAudioFrame(data: ArrayBuffer | Uint8Array): boolean {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.byteLength < 4) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getUint32(0, true) === AUDIO_FRAME_MAGIC;
}
