import { createSocket, type Socket } from "node:dgram";
import { spawn, type ChildProcess } from "node:child_process";
import { RtpPacket, type MediaStreamTrack } from "werift";

/**
 * Spawns an ffmpeg process that encodes into RTP over a local UDP port, and
 * relays every packet it emits into a werift MediaStreamTrack via writeRtp().
 * One instance per track (video or audio). Crash-only: if ffmpeg exits, the
 * relay just stops forwarding until stop()/start() is called again — mirrors
 * FfmpegCapture/AudioCapture's "no hot-loop respawn" behavior.
 */
export class RtpRelay {
  private proc: ChildProcess | null = null;
  private socket: Socket | null = null;
  /** Bumped on every stop(); lets an in-flight start() detect it was cancelled. */
  private generation = 0;

  constructor(
    private readonly kind: "video" | "audio",
    /** Builds the full ffmpeg args given the chosen local RTP port. */
    private readonly buildArgs: (port: number) => string[],
  ) {}

  async start(track: MediaStreamTrack): Promise<void> {
    this.stop();
    const generation = this.generation;
    const port = await randomUdpPort();
    if (generation !== this.generation) {
      // stop() was called while we were awaiting the port; abandon setup.
      return;
    }
    const socket = createSocket("udp4");
    socket.on("message", (data) => {
      try {
        track.writeRtp(RtpPacket.deSerialize(data));
      } catch (err) {
        process.stderr.write(`[webrtc:${this.kind}] bad RTP packet: ${String(err)}\n`);
      }
    });
    socket.on("error", (err) => {
      process.stderr.write(`[webrtc:${this.kind}] RTP socket error: ${String(err)}\n`);
    });
    socket.bind(port, "127.0.0.1");
    this.socket = socket;

    const proc = spawn("ffmpeg", this.buildArgs(port), { stdio: ["ignore", "ignore", "ignore"] });
    this.proc = proc;
    proc.on("error", (err) => {
      process.stderr.write(`[webrtc:${this.kind}] ffmpeg spawn error: ${String(err)}\n`);
    });
    proc.on("exit", (code) => {
      if (this.proc === proc) this.proc = null;
      if (code !== null && code !== 0) {
        process.stderr.write(`[webrtc:${this.kind}] ffmpeg exited with code ${code}\n`);
      }
    });
  }

  stop(): void {
    this.generation++;
    if (this.proc) {
      this.proc.kill("SIGKILL");
      this.proc = null;
    }
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
  }
}

/** Bind to port 0 to let the OS pick a free UDP port, then read it back. */
function randomUdpPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createSocket("udp4");
    probe.bind(0, "127.0.0.1", () => {
      const port = (probe.address() as { port: number }).port;
      probe.close(() => resolve(port));
    });
    probe.on("error", reject);
  });
}
