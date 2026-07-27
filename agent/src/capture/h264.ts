import { Decoder, DeviceAPI, FilterAPI } from "node-av/api";
import { Codec, CodecContext, Dictionary, Packet, Rational, type Frame } from "node-av";
import {
  AV_PIX_FMT_YUV420P,
  AV_PICTURE_TYPE_I,
  AV_PICTURE_TYPE_NONE,
  FF_ENCODER_LIBX264,
} from "node-av/constants";
import { FrameFormat } from "@bcsa/shared";
import type { FrameHandler, ScreenCapture } from "./index.js";

/**
 * Screen capture that emits H.264, entirely in-process.
 *
 * ## Why H.264 rather than Classic's MJPEG
 *
 * Every JPEG is intra-coded, so a completely static screen costs full price on
 * every frame: measured at ~267KB/frame on a 1920-wide desktop, which is
 * ~63 Mbit/s at 30fps and is why Classic only ever worked well on a LAN. H.264
 * sends only what changed — measured on a real desktop at ~7.4KB/frame,
 * roughly 1.8 Mbit/s. That ~35x reduction is what makes video usable over a
 * real network.
 *
 * ## Why there is no ffmpeg subprocess
 *
 * An ffmpeg child process cannot be reconfigured once started: no live bitrate
 * change, no resolution change, and above all no keyframe on demand (verified
 * — this ffmpeg build exposes no `zmq` filter, and neither `scale`, `fps` nor
 * libx264 accept runtime commands). A receiver that joins late or loses a
 * keyframe then renders nothing until the GOP rolls round, which is seconds of
 * blank screen.
 *
 * Driving libav in-process makes all three ordinary calls. It also removes an
 * entire class of failure this project kept hitting: no pipe carrying
 * undelimited rawvideo whose frame boundaries must be guessed, no `-pix_fmt`
 * that silently attaches to the input instead of the output, no stderr
 * scraping, and no wedged-but-alive child process to watch for.
 *
 * On macOS `DeviceAPI.openScreen()` additionally reaches ScreenCaptureKit,
 * Apple's current capture API, rather than the legacy avfoundation path that
 * logs "Configuration of video device failed, falling back to default".
 *
 * ## The low-level encoder API is deliberate
 *
 * This uses `CodecContext.sendFrame()` rather than node-av's ergonomic
 * `Encoder.packets()` wrapper, because that wrapper silently drops
 * `frame.pict_type` — verified by tagging a frame, reading the property back
 * as I, and observing no IDR in the output. Requested keyframes would simply
 * never appear, and since a receiver cannot decode anything before its first
 * keyframe, that surfaces as a permanently black screen. Do not "simplify"
 * this to the high-level API without re-verifying that forced keyframes still
 * come out.
 */
export interface H264CaptureOptions {
  /** Encoded output width; height follows the display's aspect ratio. */
  width?: number;
  fps?: number;
  bitrateKbps?: number;
  /**
   * Seconds between automatic IDRs. Only a recovery floor — a receiver that
   * needs one sooner asks, and requestKeyframe() answers immediately.
   */
  gopSeconds?: number;
}

const DEFAULTS = { width: 1280, fps: 30, bitrateKbps: 2500, gopSeconds: 2 };

export class H264Capture implements ScreenCapture {
  private handler: FrameHandler | null = null;
  private running = false;
  /** Bumped on every (re)start so a superseded pump loop exits. */
  private generation = 0;
  private width: number;
  private fps: number;
  private bitrateKbps: number;
  private gopSeconds: number;
  private pts = 0n;
  /** Set by requestKeyframe(); consumed by the next frame encoded. */
  private forceKeyframe = false;

  constructor(opts: H264CaptureOptions = {}) {
    this.width = opts.width ?? DEFAULTS.width;
    this.fps = opts.fps ?? DEFAULTS.fps;
    this.bitrateKbps = opts.bitrateKbps ?? DEFAULTS.bitrateKbps;
    this.gopSeconds = opts.gopSeconds ?? DEFAULTS.gopSeconds;
  }

  start(handler: FrameHandler): void {
    this.handler = handler;
    this.running = true;
    void this.pump(++this.generation);
  }

  /**
   * Cadence control, to satisfy the ScreenCapture interface. Interpreted as an
   * fps target; changing it restarts capture, since the device's frame rate and
   * the encoder's timebase are both fixed when they are opened.
   */
  setInterval(ms: number): void {
    const fps = Math.min(60, Math.max(1, Math.round(1000 / ms)));
    if (fps === this.fps) return;
    this.fps = fps;
    if (this.running) void this.pump(++this.generation);
  }

  /**
   * Emit an IDR on the next frame.
   *
   * This is the capability that justifies an in-process encoder at all. A
   * receiver cannot decode anything until it has a keyframe, so on a fresh
   * connection or after loss it must be able to ask for one rather than wait
   * out the GOP.
   */
  requestKeyframe(): void {
    this.forceKeyframe = true;
  }

  /**
   * Re-open the encoder at a new bitrate, measured at ~2.2ms.
   *
   * Cheap enough to treat as continuous adaptation: the equivalent for a
   * subprocess was a ~300ms restart plus a capture-device reopen, which is why
   * adaptive quality was previously impractical here. The new encoder opens
   * with an IDR, so the receiver never sees a gap.
   */
  setBitrate(kbps: number): void {
    if (kbps === this.bitrateKbps || kbps <= 0) return;
    this.bitrateKbps = kbps;
    if (this.running) void this.pump(++this.generation);
  }

  stop(): void {
    this.running = false;
    this.handler = null;
    this.generation++;
  }

  private async openEncoder(width: number, height: number): Promise<CodecContext> {
    const codec = Codec.findEncoderByName(FF_ENCODER_LIBX264);
    if (!codec) throw new Error("libx264 encoder unavailable");
    const ctx = new CodecContext();
    ctx.allocContext3(codec);
    ctx.width = width;
    ctx.height = height;
    ctx.pixelFormat = AV_PIX_FMT_YUV420P;
    ctx.timeBase = new Rational(1, this.fps);
    ctx.framerate = new Rational(this.fps, 1);
    ctx.gopSize = this.fps * this.gopSeconds;
    ctx.bitRate = BigInt(this.bitrateKbps * 1000);
    const ret = await ctx.open2(
      codec,
      Dictionary.fromObject({
        preset: "ultrafast",
        tune: "zerolatency",
        // Without forced-idr, pict_type=I yields an open-GOP I-frame that a
        // receiver cannot start decoding from.
        "forced-idr": "1",
        // One slice per frame: browser decoders handle multi-slice frames
        // unreliably, and `tune=zerolatency` enables slicing by default.
        "x264-params": "sliced-threads=0",
        threads: "1",
      }),
    );
    if (ret < 0) throw new Error(`failed to open H.264 encoder (${ret})`);
    return ctx;
  }

  /**
   * Runs one capture -> scale -> encode session until superseded or stopped.
   *
   * Guarded by `generation` rather than a boolean so a restart (fps or bitrate
   * change) cleanly abandons the previous loop: the old iteration sees a stale
   * generation on its next frame and returns, leaving exactly one pump running.
   */
  private async pump(generation: number): Promise<void> {
    try {
      const demuxer = await DeviceAPI.openScreen({ frameRate: this.fps });
      const stream = demuxer.video();
      if (!stream) throw new Error("screen device exposed no video stream");

      const srcW = stream.codecpar.width;
      const srcH = stream.codecpar.height;
      // Even dimensions are mandatory: yuv420p subsamples chroma 2x2, so an odd
      // width or height is rejected by the encoder outright. Odd source sizes
      // are ordinary — fractional DPI scaling yields sizes like 1707x1067.
      const w = Math.trunc(Math.min(this.width, srcW) / 2) * 2;
      const h = Math.trunc((srcH * w) / srcW / 2) * 2;

      const decoder = await Decoder.create(stream);
      // The filter graph does scaling and pixel-format conversion in one pass:
      // the screen device delivers nv12 (ScreenCaptureKit) or a packed RGB
      // variant depending on platform, and libx264 needs planar yuv420p.
      const filter = FilterAPI.create(`scale=${w}:${h},format=yuv420p`);
      const ctx = await this.openEncoder(w, h);
      this.pts = 0n;
      // A new encoder's first frame must be an IDR, or the receiver has
      // nothing to start decoding from.
      this.forceKeyframe = true;

      for await (const frame of decoder.frames(demuxer.packets(stream.index))) {
        if (generation !== this.generation || !this.running) break;
        if (!frame) continue;
        await filter.process(frame);
        const scaled = await filter.receive();
        frame.free?.();
        if (!scaled) continue;
        await this.encodeOne(ctx, scaled);
        scaled.free?.();
      }
    } catch (err) {
      if (generation === this.generation && this.running) {
        process.stderr.write(`[h264] capture failed: ${String(err)}\n`);
      }
    }
  }

  private async encodeOne(ctx: CodecContext, frame: Frame): Promise<void> {
    const handler = this.handler;
    if (!handler) return;
    frame.pts = this.pts++;
    frame.pictType = this.forceKeyframe ? AV_PICTURE_TYPE_I : AV_PICTURE_TYPE_NONE;
    this.forceKeyframe = false;

    await ctx.sendFrame(frame);
    for (;;) {
      const pkt = new Packet();
      pkt.alloc();
      const ret = await ctx.receivePacket(pkt);
      if (ret < 0) {
        pkt.free?.();
        break;
      }
      const bytes = pkt.data;
      if (bytes && bytes.length) {
        handler({
          data: new Uint8Array(bytes),
          format: FrameFormat.H264,
          keyframe: pkt.isKeyframe ?? false,
        });
      }
      pkt.free?.();
    }
  }
}
