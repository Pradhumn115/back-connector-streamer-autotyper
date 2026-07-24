// Measures the real frame rate + average JPEG size the ffmpeg capture produces.
import { FfmpegCapture } from "../agent/dist/capture/ffmpeg.js";

const seconds = Number(process.argv[2] || 3);
const intervalMs = Number(process.argv[3] || 16); // default ~60fps target
const cap = new FfmpegCapture({ maxWidth: 1440, quality: 6 });
let frames = 0;
let bytes = 0;
cap.setInterval(intervalMs);
cap.start((img) => {
  frames++;
  bytes += img.data.byteLength;
});

setTimeout(() => {
  cap.stop();
  const fps = frames / seconds;
  const avgKb = frames ? bytes / frames / 1024 : 0;
  console.log(`frames: ${frames} in ${seconds}s -> ${fps.toFixed(1)} fps`);
  console.log(`avg frame: ${avgKb.toFixed(0)} KB -> ~${((bytes / seconds) / 1024 / 1024 * 8).toFixed(1)} Mbps`);
  process.exit(0);
}, seconds * 1000);
