import { X509Certificate } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import selfsigned from "selfsigned";
import { DATA_DIR } from "./config.js";

const CERT_PATH = join(DATA_DIR, "cert.pem");
const KEY_PATH = join(DATA_DIR, "key.pem");

export interface TlsMaterial {
  cert: string;
  key: string;
  /** SHA-256 fingerprint of the certificate, for the client to pin. */
  fingerprint: string;
}

/**
 * Load the persisted self-signed cert/key, generating them on first run.
 * The certificate is long-lived (10 years) since it's pinned by fingerprint,
 * not validated against a CA.
 */
export function loadOrCreateTls(): TlsMaterial {
  let cert: string;
  let key: string;

  if (existsSync(CERT_PATH) && existsSync(KEY_PATH)) {
    cert = readFileSync(CERT_PATH, "utf8");
    key = readFileSync(KEY_PATH, "utf8");
  } else {
    const attrs = [{ name: "commonName", value: "bcsa-agent" }];
    const pems = selfsigned.generate(attrs, {
      days: 3650,
      keySize: 2048,
      algorithm: "sha256",
    });
    cert = pems.cert;
    key = pems.private;
    writeFileSync(CERT_PATH, cert);
    writeFileSync(KEY_PATH, key);
  }

  return { cert, key, fingerprint: fingerprintOf(cert) };
}

/** Colon-separated uppercase hex SHA-256 fingerprint of a PEM certificate. */
export function fingerprintOf(certPem: string): string {
  return new X509Certificate(certPem).fingerprint256;
}
