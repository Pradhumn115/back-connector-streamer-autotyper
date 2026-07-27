import { H264Capture } from "../src/capture/h264.js";
import { FrameFormat } from "@bcsa/shared";
let n = 0, bytes = 0, tiny = 0;
const sizes: number[] = [];
const cap = new H264Capture({ width: 1280, fps: 30, bitrateKbps: 2500 });
cap.start((img) => {
  if (img.format !== FrameFormat.H264) return;
  n++; bytes += img.data.length; sizes.push(img.data.length);
  if (img.data.length < 1000) tiny++;
});
setTimeout(() => {
  cap.stop();
  if (!n) { console.log("no frames captured"); process.exit(0); }
  sizes.sort((a, b) => a - b);
  console.log(`frames=${n}  avg=${(bytes/n).toFixed(0)}B  median=${sizes[Math.floor(n/2)]}B  min=${sizes[0]}B`);
  console.log(`under 1KB: ${tiny}/${n}  → idle cost ${(bytes/n*8*30/1e6).toFixed(2)} Mbit/s`);
  process.exit(0);
}, 12000);
