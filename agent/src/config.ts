import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Directory where the agent persists its config and TLS material. */
export const DATA_DIR = join(__dirname, "..", ".data");

const CONFIG_PATH = join(DATA_DIR, "config.json");

export interface AgentConfig {
  /** Shared secret the client must present. Auto-generated on first run. */
  secret: string;
  /** TCP port the WSS server listens on. */
  port: number;
  /** Human-friendly name shown in the client. */
  nickname: string;
}

const DEFAULT_PORT = 8443;

function ensureDataDir(): void {
  // Owner-only directory: it holds the shared secret and the TLS private key.
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  else chmodSync(DATA_DIR, 0o700);
}

/**
 * Load config from disk, creating it (with a freshly generated secret) on first
 * run. Environment variables override persisted values: BCSA_PORT, BCSA_SECRET,
 * BCSA_NICKNAME.
 */
export function loadConfig(): AgentConfig {
  ensureDataDir();

  let cfg: AgentConfig;
  if (existsSync(CONFIG_PATH)) {
    cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as AgentConfig;
    chmodSync(CONFIG_PATH, 0o600); // repair perms on pre-existing installs
  } else {
    cfg = {
      // 24 bytes -> ~192 bits of entropy, 32 base64url chars.
      secret: randomBytes(24).toString("base64url"),
      port: DEFAULT_PORT,
      nickname: hostname(),
    };
    writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  }

  if (process.env.BCSA_PORT) cfg.port = Number(process.env.BCSA_PORT);
  if (process.env.BCSA_SECRET) cfg.secret = process.env.BCSA_SECRET;
  if (process.env.BCSA_NICKNAME) cfg.nickname = process.env.BCSA_NICKNAME;

  return cfg;
}
