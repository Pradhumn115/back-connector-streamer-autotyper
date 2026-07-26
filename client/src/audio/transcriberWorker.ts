/// <reference lib="webworker" />
/**
 * Web Worker that runs a speech-to-text model (transformers.js) off the main
 * thread so transcription never freezes the UI. Loads the model lazily on the
 * first `load` message, then transcribes Float32Array windows (16 kHz mono)
 * posted to it. Prefers WebGPU (5–10× faster) and falls back to WASM.
 *
 * Supports switching between multiple STT models (see MODEL_CONFIGS) so their
 * output quality and latency can be compared side by side. Each model's
 * pipeline is cached independently once loaded, so switching back and forth
 * after the first load of each is instant.
 *
 * Messages IN:  { type: "load", model: ModelKey }
 *             | { type: "transcribe", id, audio, model: ModelKey, chunkLengthS? }
 * Messages OUT: { type: "progress", model, progress } | { type: "ready", model, device }
 *             | { type: "result", id, text } | { type: "error", id?, error }
 *
 * Each transcribe carries an `id` the main thread correlates to its request, so
 * it can await individual segments (needed for Record mode's N-segment takes).
 */
import { pipeline, env, type AutomaticSpeechRecognitionPipeline } from "@huggingface/transformers";

// Model weights come from the Hugging Face CDN (fetched by this browser, cached
// after the first load); we never look for local model files.
env.allowLocalModels = false;

export type ModelKey = "whisper" | "moonshine";

interface ModelConfig {
  id: string;
  /**
   * Whisper's pipeline accepts `chunk_length_s` to handle >30s long-form audio
   * by internally splitting it. Moonshine has no such long-form chunking
   * support in transformers.js -- passing the option is simply ignored, but
   * omitting it (letting our own VAD-segmented audio pass straight through)
   * is the correct usage for it either way.
   */
  supportsChunking: boolean;
}

export const MODEL_CONFIGS: Record<ModelKey, ModelConfig> = {
  whisper: { id: "onnx-community/whisper-base.en", supportsChunking: true },
  moonshine: { id: "onnx-community/moonshine-base-ONNX", supportsChunking: false },
};

const transcribers = new Map<ModelKey, AutomaticSpeechRecognitionPipeline>();
const loading = new Map<ModelKey, Promise<AutomaticSpeechRecognitionPipeline>>();

function pickDevice(): "webgpu" | "wasm" {
  return typeof navigator !== "undefined" && "gpu" in navigator ? "webgpu" : "wasm";
}

async function getTranscriber(model: ModelKey): Promise<AutomaticSpeechRecognitionPipeline> {
  const cached = transcribers.get(model);
  if (cached) return cached;
  let inFlight = loading.get(model);
  if (!inFlight) {
    const device = pickDevice();
    // dtype matters per device: on WASM, q8 is small (~50MB) and accurate. On
    // WebGPU, a q8 *decoder* produces garbage tokens for Whisper -- so use
    // fp32 there (the WebGPU default), which transcribes correctly.
    // Mismatching this yields fluent-looking nonsense, not an error.
    const dtype = device === "webgpu" ? "fp32" : "q8";
    inFlight = pipeline("automatic-speech-recognition", MODEL_CONFIGS[model].id, {
      device,
      dtype,
      progress_callback: (p: unknown) => {
        const data = p as { progress?: number };
        if (typeof data.progress === "number") {
          self.postMessage({ type: "progress", model, progress: data.progress });
        }
      },
    }).then((t) => {
      const transcriber = t as AutomaticSpeechRecognitionPipeline;
      transcribers.set(model, transcriber);
      self.postMessage({ type: "ready", model, device });
      return transcriber;
    });
    loading.set(model, inFlight);
  }
  return inFlight;
}

self.addEventListener("message", async (e: MessageEvent) => {
  const msg = e.data as
    | { type: "load"; model: ModelKey }
    | { type: "transcribe"; id: number; audio: Float32Array; model: ModelKey; chunkLengthS?: number };

  if (msg.type === "load") {
    try {
      await getTranscriber(msg.model);
    } catch (err) {
      self.postMessage({ type: "error", error: String(err) });
    }
    return;
  }

  if (msg.type === "transcribe") {
    try {
      const t = await getTranscriber(msg.model);
      // chunk_length_s lets Whisper handle long (>30s) record takes; omit it
      // for short live utterances (cheaper single-pass) and for models that
      // don't support it (see ModelConfig.supportsChunking).
      const opts =
        msg.chunkLengthS && MODEL_CONFIGS[msg.model].supportsChunking
          ? { chunk_length_s: msg.chunkLengthS }
          : undefined;
      const start = performance.now();
      const out = (await t(msg.audio, opts)) as { text?: string };
      const latencyMs = performance.now() - start;
      self.postMessage({
        type: "result",
        id: msg.id,
        text: (out.text ?? "").trim(),
        latencyMs,
      });
    } catch (err) {
      self.postMessage({ type: "error", id: msg.id, error: String(err) });
    }
  }
});
