/**
 * Minimal typings for `@fails-components/webtransport`.
 *
 * The package ships types at `dist/lib/index.node.d.ts` behind a `node`
 * export condition, which this project's `moduleResolution: "Bundler"` does
 * not select — so TypeScript sees the package as untyped. Rather than change
 * module resolution for the whole workspace (which affects every import), this
 * declares only the surface the agent actually uses.
 *
 * Deliberately narrow: anything added here is a claim about the library's
 * behaviour that nothing checks, so the less of it there is, the less can be
 * silently wrong.
 */
declare module "@fails-components/webtransport" {
  export interface Http3ServerInit {
    port: number;
    host: string;
    secret: string;
    cert: string;
    privKey: string;
  }

  /** One accepted client, in the shape the server module consumes. */
  export interface WebtransportSession {
    ready: Promise<void>;
    closed: Promise<unknown>;
    createUnidirectionalStream(): Promise<WritableStream<Uint8Array>>;
  }

  export class Http3Server {
    constructor(init: Http3ServerInit);
    startServer(): void;
    stopServer(): Promise<void>;
    /** Incoming sessions for a path, e.g. "/video". */
    sessionStream(path: string): ReadableStream<WebtransportSession>;
  }
}
