import { X509Certificate } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
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

/** SAN entry types, from RFC 5280 as the `selfsigned` package encodes them. */
const SAN_DNS = 2;
const SAN_IP = 7;

/**
 * Every address this machine can be reached on, for the certificate's SANs.
 *
 * ## Why this list has to exist
 *
 * A certificate identifies itself through Subject Alternative Names, and
 * nothing else — browsers stopped honouring `commonName` years ago. A cert
 * without a SAN for the address in the URL bar does not match it, whatever the
 * common name says.
 *
 * The generated certificate previously carried exactly one SAN:
 * `URI:http://example.org/webid#me`, the placeholder from the `selfsigned`
 * package's own example. It named no host and no IP, so it matched no address
 * the agent is ever reached on — every origin failed validation for two
 * independent reasons rather than one, and the browser's "not secure" warning
 * was strictly correct.
 *
 * Being self-signed still means a warning on first visit; that part needs a
 * real CA (see the README on Tailscale certificates). What this fixes is the
 * cert being able to identify the machine at all, which is what makes trusting
 * it on a device — or pinning its fingerprint — mean anything.
 */
function localAddresses(): { dns: string[]; ips: string[] } {
  const ips = new Set<string>(["127.0.0.1", "::1"]);
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      // A zone index (%en0) belongs to the socket rather than the certificate
      // and would make the SAN unparseable.
      if (addr.address.includes("%")) continue;
      // Link-local v6 is per-interface and unreachable from anywhere a browser
      // would connect from; this machine reports a dozen of them, which would
      // be a dozen SAN entries that can never match a URL.
      if (addr.address.toLowerCase().startsWith("fe80:")) continue;
      ips.add(addr.address);
    }
  }
  const dns = new Set<string>(["localhost"]);
  return { dns: [...dns], ips: [...ips] };
}

/**
 * Load the persisted self-signed cert/key, generating them on first run.
 *
 * Long-lived (10 years) because it is trusted by fingerprint or by an explicit
 * browser exception, never by a CA — so expiry would only ever mean repeating
 * that acceptance for no security gain.
 *
 * The certificate is regenerated when it names none of this machine's current
 * addresses. A laptop changes networks, and a certificate that was correct on
 * one is wrong on the next; more importantly it lets installs created before
 * SANs existed repair themselves rather than staying permanently unmatchable.
 */
export function loadOrCreateTls(): TlsMaterial {
  const supplied = suppliedTls();
  if (supplied) return supplied;

  const { dns, ips } = localAddresses();

  if (existsSync(CERT_PATH) && existsSync(KEY_PATH)) {
    const cert = readFileSync(CERT_PATH, "utf8");
    const key = readFileSync(KEY_PATH, "utf8");
    if (certCoversLoopback(cert)) {
      chmodSync(KEY_PATH, 0o600); // repair perms on pre-existing installs
      return { cert, key, fingerprint: fingerprintOf(cert) };
    }
    // Otherwise fall through and replace it.
  }

  const pems = selfsigned.generate([{ name: "commonName", value: "bcsa-agent" }], {
    days: 3650,
    keySize: 2048,
    algorithm: "sha256",
    extensions: [
      {
        name: "subjectAltName",
        altNames: [
          ...dns.map((value) => ({ type: SAN_DNS, value })),
          ...ips.map((ip) => ({ type: SAN_IP, ip })),
        ],
      },
    ],
  });

  writeFileSync(CERT_PATH, pems.cert, { mode: 0o600 });
  writeFileSync(KEY_PATH, pems.private, { mode: 0o600 }); // private key: owner-only
  chmodSync(KEY_PATH, 0o600);
  return { cert: pems.cert, key: pems.private, fingerprint: fingerprintOf(pems.cert) };
}

/**
 * A certificate supplied by the operator, via BCSA_TLS_CERT / BCSA_TLS_KEY.
 *
 * The point of this hook is to escape the self-signed warning entirely. A
 * generated certificate can name every address correctly and browsers will
 * still refuse it, because nothing vouches for it — that is what a certificate
 * authority is for. Tailscale will issue a real Let's Encrypt certificate for a
 * machine's `ts.net` name at no cost, and pointing these two variables at it
 * means no warning on any device, phones included.
 *
 * A path that is set but unreadable is fatal rather than a silent fallback to
 * the self-signed certificate: someone who configured a real certificate and
 * quietly got the untrusted one back would be told the opposite of the truth
 * about how their connection is protected.
 */
function suppliedTls(): TlsMaterial | null {
  const certPath = process.env.BCSA_TLS_CERT;
  const keyPath = process.env.BCSA_TLS_KEY;
  if (!certPath && !keyPath) return null;
  if (!certPath || !keyPath) {
    throw new Error("BCSA_TLS_CERT and BCSA_TLS_KEY must be set together");
  }

  let cert: string;
  let key: string;
  try {
    cert = readFileSync(certPath, "utf8");
    key = readFileSync(keyPath, "utf8");
  } catch (err) {
    throw new Error(
      `could not read the TLS certificate or key given by BCSA_TLS_CERT/BCSA_TLS_KEY: ${String(err)}`,
    );
  }

  // Parsed rather than trusted: a malformed certificate would otherwise fail
  // later, inside the TLS handshake, where the error says nothing about which
  // file was wrong.
  try {
    new X509Certificate(cert);
  } catch (err) {
    throw new Error(`BCSA_TLS_CERT is not a valid PEM certificate: ${String(err)}`);
  }

  return { cert, key, fingerprint: fingerprintOf(cert) };
}

/**
 * True if the certificate names at least the loopback address.
 *
 * Loopback is the one address every machine has and never loses, so it is a
 * reliable marker for "this certificate was generated with real SANs". Testing
 * the full current address list instead would regenerate the certificate — and
 * invalidate every browser exception already granted to it — every time the
 * machine joined a different network.
 */
export function certCoversLoopback(certPem: string): boolean {
  try {
    const san = new X509Certificate(certPem).subjectAltName;
    if (!san) return false;
    return san.split(",").some((entry) => entry.trim() === "IP Address:127.0.0.1");
  } catch {
    return false;
  }
}

/** Colon-separated uppercase hex SHA-256 fingerprint of a PEM certificate. */
export function fingerprintOf(certPem: string): string {
  return new X509Certificate(certPem).fingerprint256;
}
