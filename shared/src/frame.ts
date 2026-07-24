/**
 * Binary frame wire format for screen frames (agent -> client).
 *
 * Layout (little-endian):
 *   offset 0 : uint32  magic   = 0x42435346 ("BCSF")
 *   offset 4 : uint32  seq     (monotonic frame sequence number)
 *   offset 8 : float64 timestamp (ms since epoch on the agent)
 *   offset 16: uint8   format  (0 = JPEG, 1 = PNG)
 *   offset 17: uint8   reserved (0)
 *   offset 18: uint16  reserved (0)
 *   offset 20: ...      image payload bytes
 */

export const FRAME_MAGIC = 0x42435346;
export const FRAME_HEADER_SIZE = 20;

export enum FrameFormat {
  JPEG = 0,
  PNG = 1,
}

export interface DecodedFrame {
  seq: number;
  timestamp: number;
  format: FrameFormat;
  payload: Uint8Array;
}

/** Encode a frame into a single ArrayBuffer suitable for ws.send(). */
export function encodeFrame(
  seq: number,
  timestamp: number,
  format: FrameFormat,
  payload: Uint8Array,
): ArrayBuffer {
  const buf = new ArrayBuffer(FRAME_HEADER_SIZE + payload.byteLength);
  const view = new DataView(buf);
  view.setUint32(0, FRAME_MAGIC, true);
  view.setUint32(4, seq >>> 0, true);
  view.setFloat64(8, timestamp, true);
  view.setUint8(16, format);
  view.setUint8(17, 0);
  view.setUint16(18, 0, true);
  new Uint8Array(buf, FRAME_HEADER_SIZE).set(payload);
  return buf;
}

/** Decode a binary frame. Returns null if it isn't a valid frame buffer. */
export function decodeFrame(data: ArrayBuffer | Uint8Array): DecodedFrame | null {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.byteLength < FRAME_HEADER_SIZE) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== FRAME_MAGIC) return null;
  const seq = view.getUint32(4, true);
  const timestamp = view.getFloat64(8, true);
  const format = view.getUint8(16) as FrameFormat;
  const payload = bytes.subarray(FRAME_HEADER_SIZE);
  return { seq, timestamp, format, payload };
}

/** True if a binary buffer looks like one of our frames (cheap magic check). */
export function isFrame(data: ArrayBuffer | Uint8Array): boolean {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.byteLength < 4) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getUint32(0, true) === FRAME_MAGIC;
}
