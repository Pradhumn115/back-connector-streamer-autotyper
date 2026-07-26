import type { DecodedAudioFrame } from "@bcsa/shared";
import { AudioFormat } from "@bcsa/shared";
import { float32ToPcmS16 } from "../audio/pcm";
import { resampleTo16kMono } from "./resample";

const CHUNK_SIZE = 4096;

/**
 * Taps a WebRTC MediaStream's audio track, resamples it to 16 kHz mono, and
 * feeds it into the existing (unmodified) transcription pipeline via the same
 * pushFrame interface the Classic PCM-over-WS path uses. Returns a cleanup
 * function that tears down the audio graph.
 */
export function tapWebrtcAudioForTranscription(
  stream: MediaStream,
  pushFrame: (frame: DecodedAudioFrame) => void,
): () => void {
  const audioTracks = stream.getAudioTracks();
  if (audioTracks.length === 0) return () => {};

  const ctx = new AudioContext();
  // Browsers' autoplay policies can start a new AudioContext "suspended"
  // until a user gesture resumes it; if it stays suspended, onaudioprocess
  // never fires and transcription silently produces nothing. The WebRTC
  // toggle click that leads here is itself a user gesture, so resume() is
  // expected to succeed; the resulting promise is fire-and-forget since
  // there's nothing actionable to do if it doesn't.
  if (ctx.state === "suspended") {
    void ctx.resume();
  }
  const source = ctx.createMediaStreamSource(new MediaStream([audioTracks[0]]));
  // ScriptProcessorNode is deprecated but is the simplest correct option here
  // and needs no build-time worklet-file wiring; AudioWorkletNode is the
  // future upgrade path if ScriptProcessorNode is ever removed from browsers
  // (no browser has removed it as of this writing).
  const processor = ctx.createScriptProcessor(CHUNK_SIZE, 1, 1);
  let seq = 0;

  processor.onaudioprocess = (e) => {
    const input = e.inputBuffer.getChannelData(0);
    const mono16k = resampleTo16kMono(input, ctx.sampleRate, 1);
    const frame: DecodedAudioFrame = {
      seq: seq++,
      timestamp: Date.now(),
      sampleRate: 16000,
      channels: 1,
      format: AudioFormat.PCM_S16LE,
      payload: float32ToPcmS16(mono16k),
    };
    pushFrame(frame);
  };

  source.connect(processor);
  // ScriptProcessorNode requires a live connection to the destination graph to
  // fire onaudioprocess even though we discard the output; route through a
  // silent gain node so nothing is audible twice (the <video> element handles
  // actual playback separately).
  const silence = ctx.createGain();
  silence.gain.value = 0;
  processor.connect(silence);
  silence.connect(ctx.destination);

  return () => {
    processor.disconnect();
    source.disconnect();
    silence.disconnect();
    void ctx.close();
  };
}
