import { useCallback, useEffect, useRef, useState } from "react";
import {
  decodeFrame,
  encodeMessage,
  FrameFormat,
  isFrame,
  parseAgentMessage,
  type AgentMessage,
  type ClientMessage,
  type DecodedFrame,
} from "@bcsa/shared";

export type ConnectionStatus =
  | "idle"
  | "connecting"
  | "authenticating"
  | "connected"
  | "error"
  | "reconnecting";

/** Info the user provides to connect. */
export interface ConnectParams {
  /** LAN address, e.g. "192.168.1.20:8443". Tried first. */
  lanAddress: string;
  /** Optional Tailscale address, e.g. "100.x.y.z:8443". Fallback. */
  tailscaleAddress: string;
  /** Shared secret sent in the auth message. */
  secret: string;
}

export interface AgentInfo {
  screenWidth: number;
  screenHeight: number;
  nickname: string;
}

/** The latest frame, exposed as an object URL ready to draw. */
export interface LatestFrame {
  url: string;
  seq: number;
  timestamp: number;
  format: FrameFormat;
}

export interface AutotypeStatus {
  done: number;
  total: number;
  active: boolean;
}

export interface UseConnection {
  status: ConnectionStatus;
  agentInfo: AgentInfo | null;
  latestFrame: LatestFrame | null;
  autotype: AutotypeStatus;
  lastError: string | null;
  params: ConnectParams;
  connect: (params: ConnectParams) => void;
  disconnect: () => void;
  send: (msg: ClientMessage) => void;
}

const STORAGE_KEY = "bcsa.connect";
const LAN_TIMEOUT_MS = 1500;
const MAX_BACKOFF_MS = 15000;

const EMPTY_PARAMS: ConnectParams = {
  lanAddress: "",
  tailscaleAddress: "",
  secret: "",
};

function loadParams(): ConnectParams {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY_PARAMS;
    const parsed = JSON.parse(raw) as Partial<ConnectParams>;
    return {
      lanAddress: parsed.lanAddress ?? "",
      tailscaleAddress: parsed.tailscaleAddress ?? "",
      secret: parsed.secret ?? "",
    };
  } catch {
    return EMPTY_PARAMS;
  }
}

function saveParams(p: ConnectParams): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
  } catch {
    // localStorage may be unavailable (private mode); non-fatal.
  }
}

const mimeForFormat: Record<FrameFormat, string> = {
  [FrameFormat.JPEG]: "image/jpeg",
  [FrameFormat.PNG]: "image/png",
};

/**
 * Ordered list of wss:// URLs to try for a given set of params.
 * LAN first, Tailscale second (if provided).
 */
function buildTargets(p: ConnectParams): string[] {
  const targets: string[] = [];
  if (p.lanAddress.trim()) targets.push(`wss://${p.lanAddress.trim()}`);
  if (p.tailscaleAddress.trim())
    targets.push(`wss://${p.tailscaleAddress.trim()}`);
  return targets;
}

/**
 * React hook that owns the whole WebSocket lifecycle: dual-path connect with a
 * per-target timeout, auth handshake, frame decoding (latest-only), and
 * reconnect-with-backoff. All timers/sockets live in refs so re-renders never
 * disturb them.
 */
export function useConnection(): UseConnection {
  const [status, setStatus] = useState<ConnectionStatus>("idle");
  const [agentInfo, setAgentInfo] = useState<AgentInfo | null>(null);
  const [latestFrame, setLatestFrame] = useState<LatestFrame | null>(null);
  const [autotype, setAutotype] = useState<AutotypeStatus>({
    done: 0,
    total: 0,
    active: false,
  });
  const [lastError, setLastError] = useState<string | null>(null);
  const [params, setParams] = useState<ConnectParams>(loadParams);

  // Mutable connection state kept out of React render cycle.
  const wsRef = useRef<WebSocket | null>(null);
  const paramsRef = useRef<ConnectParams>(params);
  const targetIdxRef = useRef<number>(0);
  const connectTimerRef = useRef<number | null>(null);
  const backoffTimerRef = useRef<number | null>(null);
  const backoffMsRef = useRef<number>(500);
  // Set once auth fails, to stop the reconnect loop until a fresh connect().
  const stoppedRef = useRef<boolean>(false);
  // The object URL currently held by latestFrame, so we can revoke on replace.
  const currentUrlRef = useRef<string | null>(null);
  const authedRef = useRef<boolean>(false);

  const clearTimers = useCallback(() => {
    if (connectTimerRef.current !== null) {
      window.clearTimeout(connectTimerRef.current);
      connectTimerRef.current = null;
    }
    if (backoffTimerRef.current !== null) {
      window.clearTimeout(backoffTimerRef.current);
      backoffTimerRef.current = null;
    }
  }, []);

  const revokeCurrentUrl = useCallback(() => {
    if (currentUrlRef.current) {
      URL.revokeObjectURL(currentUrlRef.current);
      currentUrlRef.current = null;
    }
  }, []);

  // Forward declaration via ref so open/close handlers can call it.
  const openTargetRef = useRef<(idx: number) => void>(() => {});

  const scheduleReconnect = useCallback(() => {
    if (stoppedRef.current) return;
    setStatus("reconnecting");
    const delay = backoffMsRef.current;
    backoffMsRef.current = Math.min(delay * 2, MAX_BACKOFF_MS);
    backoffTimerRef.current = window.setTimeout(() => {
      // Restart the target sweep from the top (LAN first).
      openTargetRef.current(0);
    }, delay);
  }, []);

  const handleAgentMessage = useCallback((msg: AgentMessage) => {
    switch (msg.type) {
      case "authResult": {
        if (msg.ok) {
          authedRef.current = true;
          setStatus("connected");
          backoffMsRef.current = 500; // reset backoff after a good auth
        } else {
          // Auth is wrong: stop retrying entirely.
          authedRef.current = false;
          stoppedRef.current = true;
          setLastError(msg.reason ?? "Authentication failed");
          setStatus("error");
          wsRef.current?.close();
        }
        break;
      }
      case "agentInfo":
        setAgentInfo({
          screenWidth: msg.screenWidth,
          screenHeight: msg.screenHeight,
          nickname: msg.nickname,
        });
        break;
      case "autotypeProgress":
        setAutotype({ done: msg.done, total: msg.total, active: true });
        break;
      case "autotypeDone":
        setAutotype((s) => ({ done: s.total, total: s.total, active: false }));
        break;
      case "agentError":
        setLastError(msg.message);
        break;
    }
  }, []);

  const handleFrame = useCallback(
    (decoded: DecodedFrame) => {
      // Drop-stale policy: build a URL for the newest frame and revoke the
      // previous one immediately. Only the latest frame is ever kept.
      const blob = new Blob([decoded.payload as BlobPart], {
        type: mimeForFormat[decoded.format] ?? "image/jpeg",
      });
      const url = URL.createObjectURL(blob);
      revokeCurrentUrl();
      currentUrlRef.current = url;
      setLatestFrame({
        url,
        seq: decoded.seq,
        timestamp: decoded.timestamp,
        format: decoded.format,
      });
    },
    [revokeCurrentUrl],
  );

  const openTarget = useCallback(
    (idx: number) => {
      clearTimers();
      const targets = buildTargets(paramsRef.current);
      if (targets.length === 0) {
        setLastError("No address provided");
        setStatus("error");
        return;
      }
      if (idx >= targets.length) {
        // Exhausted all targets for this attempt: back off and retry.
        scheduleReconnect();
        return;
      }

      targetIdxRef.current = idx;
      authedRef.current = false;
      setStatus(idx === 0 ? "connecting" : "connecting");

      let ws: WebSocket;
      try {
        ws = new WebSocket(targets[idx]);
      } catch (err) {
        setLastError(err instanceof Error ? err.message : String(err));
        openTargetRef.current(idx + 1);
        return;
      }
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;

      // Per-target connect timeout: if it doesn't open in time, move on.
      connectTimerRef.current = window.setTimeout(() => {
        if (ws.readyState !== WebSocket.OPEN) {
          try {
            ws.close();
          } catch {
            // ignore
          }
          // onclose will advance; guard against double-advance by nulling ref.
          if (wsRef.current === ws) wsRef.current = null;
          openTargetRef.current(idx + 1);
        }
      }, LAN_TIMEOUT_MS);

      ws.onopen = () => {
        if (connectTimerRef.current !== null) {
          window.clearTimeout(connectTimerRef.current);
          connectTimerRef.current = null;
        }
        setStatus("authenticating");
        ws.send(
          encodeMessage({ type: "auth", secret: paramsRef.current.secret }),
        );
      };

      ws.onmessage = (event: MessageEvent) => {
        const data = event.data;
        if (typeof data === "string") {
          try {
            handleAgentMessage(parseAgentMessage(data));
          } catch (err) {
            setLastError(
              `Bad message: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          return;
        }
        if (data instanceof ArrayBuffer) {
          if (isFrame(data)) {
            const decoded = decodeFrame(data);
            if (decoded) handleFrame(decoded);
          }
        }
      };

      ws.onerror = () => {
        // Errors are followed by a close event; let onclose drive transitions.
      };

      ws.onclose = () => {
        if (wsRef.current !== ws) return; // superseded by a newer socket
        wsRef.current = null;
        if (connectTimerRef.current !== null) {
          window.clearTimeout(connectTimerRef.current);
          connectTimerRef.current = null;
        }
        if (stoppedRef.current) {
          // Auth failed or user disconnected: do not reconnect.
          return;
        }
        if (authedRef.current) {
          // Unexpected drop after a good session: reconnect with backoff.
          authedRef.current = false;
          scheduleReconnect();
        } else {
          // Never authed on this target: try the next target immediately.
          openTargetRef.current(idx + 1);
        }
      };
    },
    [clearTimers, handleAgentMessage, handleFrame, scheduleReconnect],
  );

  useEffect(() => {
    openTargetRef.current = openTarget;
  }, [openTarget]);

  const disconnect = useCallback(() => {
    stoppedRef.current = true;
    clearTimers();
    const ws = wsRef.current;
    wsRef.current = null;
    if (ws) {
      ws.onclose = null;
      ws.onmessage = null;
      ws.onopen = null;
      ws.onerror = null;
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
    authedRef.current = false;
    revokeCurrentUrl();
    setLatestFrame(null);
    setAgentInfo(null);
    setAutotype({ done: 0, total: 0, active: false });
    setStatus("idle");
  }, [clearTimers, revokeCurrentUrl]);

  const connect = useCallback(
    (next: ConnectParams) => {
      // Tear down any existing connection first.
      const ws = wsRef.current;
      wsRef.current = null;
      if (ws) {
        ws.onclose = null;
        ws.onmessage = null;
        ws.onopen = null;
        ws.onerror = null;
        try {
          ws.close();
        } catch {
          // ignore
        }
      }
      clearTimers();
      revokeCurrentUrl();
      setLatestFrame(null);
      setAgentInfo(null);
      setAutotype({ done: 0, total: 0, active: false });
      setLastError(null);

      paramsRef.current = next;
      setParams(next);
      saveParams(next);
      stoppedRef.current = false;
      authedRef.current = false;
      backoffMsRef.current = 500;
      openTargetRef.current(0);
    },
    [clearTimers, revokeCurrentUrl],
  );

  const send = useCallback((msg: ClientMessage) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(encodeMessage(msg));
    }
  }, []);

  // Clean up on unmount.
  useEffect(() => {
    return () => {
      stoppedRef.current = true;
      clearTimers();
      const ws = wsRef.current;
      wsRef.current = null;
      if (ws) {
        ws.onclose = null;
        try {
          ws.close();
        } catch {
          // ignore
        }
      }
      revokeCurrentUrl();
    };
  }, [clearTimers, revokeCurrentUrl]);

  return {
    status,
    agentInfo,
    latestFrame,
    autotype,
    lastError,
    params,
    connect,
    disconnect,
    send,
  };
}
