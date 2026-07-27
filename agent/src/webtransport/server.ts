import { Http3Server, type WebtransportSession } from "@fails-components/webtransport";
import { generateWebtransportCert, type WebtransportCert } from "./cert.js";

/**
 * Carries video frames to the client over QUIC instead of the control
 * WebSocket.
 *
 * ## Why a second transport at all
 *
 * The WebSocket is TCP, so a lost packet stalls everything behind it until it
 * is retransmitted — and for live video that retransmission is usually
 * worthless, because by the time it lands the frame it belongs to is stale.
 * QUIC runs on UDP and gives each stream its own ordering, so loss in one
 * frame never blocks the next.
 *
 * That matters on lossy links and matters very little on a clean LAN, which is
 * why this is an addition rather than a replacement: the WebSocket path stays
 * and is still the only one that works for a browser without WebTransport
 * (Safari at time of writing) or over a Cloudflare Tunnel, which carries HTTP
 * and cannot carry QUIC at all.
 *
 * ## One stream per frame, not datagrams
 *
 * QUIC datagrams cap out around 1200 bytes, so a frame would need RTP-style
 * fragmentation and reassembly, and any lost fragment would corrupt the frame
 * anyway. A unidirectional stream per frame gets the property we actually want
 * — no head-of-line blocking BETWEEN frames — while each frame arrives whole
 * or not at all, with no fragmentation layer to write.
 */
export interface WebtransportServerOptions {
  /** UDP port to listen on. */
  port: number;
  host?: string;
}

export class WebtransportServer {
  private server: Http3Server | null = null;
  private certificate: WebtransportCert | null = null;
  /** Sessions currently able to receive frames. */
  private sessions = new Set<WebtransportSession>();
  private closed = false;

  constructor(private readonly opts: WebtransportServerOptions) {}

  /** SHA-256 of the certificate, for the client's serverCertificateHashes. */
  get certHash(): string | null {
    return this.certificate?.hash ?? null;
  }

  get port(): number {
    return this.opts.port;
  }

  /** True once at least one client is attached and frames are worth sending. */
  get hasSession(): boolean {
    return this.sessions.size > 0;
  }

  async start(): Promise<void> {
    this.certificate = await generateWebtransportCert();
    const server = new Http3Server({
      port: this.opts.port,
      host: this.opts.host ?? "0.0.0.0",
      secret: "bcsa",
      cert: this.certificate.cert,
      privKey: this.certificate.key,
    });
    this.server = server;
    server.startServer();
    void this.acceptSessions(server);
  }

  private async acceptSessions(server: Http3Server): Promise<void> {
    try {
      const stream = server.sessionStream("/video");
      const reader = stream.getReader();
      for (;;) {
        const { value: session, done } = await reader.read();
        if (done || this.closed) break;
        if (!session) continue;
        void this.trackSession(session);
      }
    } catch (err) {
      if (!this.closed) {
        process.stderr.write(`[webtransport] accept loop ended: ${String(err)}\n`);
      }
    }
  }

  private async trackSession(session: WebtransportSession): Promise<void> {
    try {
      await session.ready;
      this.sessions.add(session);
      process.stderr.write("[webtransport] client attached\n");
      await session.closed;
    } catch {
      // A session that fails to become ready is simply never used; the client
      // stays on the WebSocket path, which is why that path is never removed.
    } finally {
      this.sessions.delete(session);
    }
  }

  /**
   * Sends one encoded frame, or reports that nobody is listening.
   *
   * Returns false rather than throwing when there is no session, so the caller
   * can fall back to the WebSocket for that frame instead of dropping it. A
   * failed write closes only that stream: one bad frame must not tear down the
   * session, since the next keyframe would recover it anyway.
   */
  async send(payload: Uint8Array): Promise<boolean> {
    if (this.sessions.size === 0) return false;
    let sent = false;
    for (const session of this.sessions) {
      try {
        const stream = await session.createUnidirectionalStream();
        const writer = stream.getWriter();
        await writer.write(payload);
        await writer.close();
        sent = true;
      } catch {
        // Drop this frame for this session; a later keyframe recovers it.
      }
    }
    return sent;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.sessions.clear();
    try {
      await this.server?.stopServer();
    } catch {
      // Already stopped.
    }
    this.server = null;
  }
}
