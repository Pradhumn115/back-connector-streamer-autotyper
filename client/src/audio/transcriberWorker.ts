/// <reference lib="webworker" />
/**
 * Web Worker that runs Whisper (transformers.js) off the main thread so
 * transcription never freezes the UI. Loads the model lazily on the first
 * `load` message, then transcribes Float32Array windows (16 kHz mono) posted to
 * it. Prefers WebGPU (5–10× faster) and falls back to WASM.
 *
 * Messages IN:  { type: "load" }
 *             | { type: "transcribe", id, audio: Float32Array, chunkLengthS? }
 * Messages OUT: { type: "progress", progress } | { type: "ready", device }
 *             | { type: "result", id, text } | { type: "error", id?, error }
 *
 * Each transcribe carries an `id` the main thread correlates to its request, so
 * it can await individual segments (needed for Record mode's N-segment takes).
 */
import { pipeline, env, type AutomaticSpeechRecognitionPipeline } from "@huggingface/transformers";

// Model weights come from the Hugging Face CDN (fetched by this browser, cached
// after the first load); we never look for local model files.
env.allowLocalModels = false;

const MODEL_ID = "onnx-community/whisper-base.en";

let transcriber: AutomaticSpeechRecognitionPipeline | null = null;
let loading: Promise<AutomaticSpeechRecognitionPipeline> | null = null;

function pickDevice(): "webgpu" | "wasm" {
  return typeof navigator !== "undefined" && "gpu" in navigator ? "webgpu" : "wasm";
}

async function getTranscriber(): Promise<AutomaticSpeechRecognitionPipeline> {
  if (transcriber) return transcriber;
  if (!loading) {
    const device = pickDevice();
    // dtype matters per device: on WASM, q8 is small (~50MB) and accurate. On
    // WebGPU, a q8 *decoder* produces garbage tokens — so use fp32 there (the
    // WebGPU default), which transcribes correctly. Mismatching this yields
    // fluent-looking nonsense, not an error.
    const dtype = device === "webgpu" ? "fp32" : "q8";
    loading = pipeline("automatic-speech-recognition", MODEL_ID, {
      device,
      dtype,
      progress_callback: (p: unknown) => {
        const data = p as { progress?: number };
        if (typeof data.progress === "number") {
          self.postMessage({ type: "progress", progress: data.progress });
        }
      },
    }).then((t) => {
      transcriber = t as AutomaticSpeechRecognitionPipeline;
      self.postMessage({ type: "ready", device });
      return transcriber;
    });
  }
  return loading;
}

self.addEventListener("message", async (e: MessageEvent) => {
  const msg = e.data as
    | { type: "load" }
    | { type: "transcribe"; id: number; audio: Float32Array; chunkLengthS?: number };

  if (msg.type === "load") {
    try {
      await getTranscriber();
    } catch (err) {
      self.postMessage({ type: "error", error: String(err) });
    }
    return;
  }

  if (msg.type === "transcribe") {
    try {
      const t = await getTranscriber();
      // chunk_length_s lets Whisper handle long (>30s) record takes; omit it for
      // short live utterances (cheaper single-pass).
      const opts = msg.chunkLengthS ? { chunk_length_s: msg.chunkLengthS } : undefined;
      const out = (await t(msg.audio, opts)) as { text?: string };
      self.postMessage({ type: "result", id: msg.id, text: (out.text ?? "").trim() });
    } catch (err) {
      self.postMessage({ type: "error", id: msg.id, error: String(err) });
    }
  }
});
