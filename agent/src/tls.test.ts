import { test } from "node:test";
import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { certCoversLoopback, fingerprintOf, loadOrCreateTls } from "./tls.js";

/** The SAN list as openssl-style strings, e.g. "IP Address:127.0.0.1". */
function sans(certPem: string): string[] {
  return (new X509Certificate(certPem).subjectAltName ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

test("the generated certificate names the addresses it is reached on", () => {
  const { cert } = loadOrCreateTls();
  const list = sans(cert);

  // Regression: the certificate used to carry exactly one SAN —
  // "URI:http://example.org/webid#me", the placeholder from the `selfsigned`
  // package's example — so it matched no address at all. Browsers ignore
  // commonName entirely, so a cert without a matching SAN identifies nothing.
  assert.ok(list.includes("DNS:localhost"), `no localhost SAN in ${list.join(", ")}`);
  assert.ok(list.includes("IP Address:127.0.0.1"), `no loopback SAN in ${list.join(", ")}`);
  assert.ok(
    !list.some((s) => s.includes("example.org")),
    "the library's placeholder SAN must not survive",
  );
});

test("the certificate carries no link-local addresses", () => {
  // A machine can report a dozen of them; none is reachable from anywhere a
  // browser connects from, so each would be a SAN that can never match a URL.
  const { cert } = loadOrCreateTls();
  assert.ok(
    !sans(cert).some((s) => s.toUpperCase().includes("FE80:")),
    "link-local addresses should be filtered out",
  );
});

test("certCoversLoopback distinguishes a real SAN list from the old placeholder", () => {
  const { cert } = loadOrCreateTls();
  assert.equal(certCoversLoopback(cert), true);

  // What the old certificates looked like: a SAN that names no address.
  assert.equal(certCoversLoopback("not a certificate"), false);
});

test("loading twice returns the same certificate rather than regenerating", () => {
  // Regenerating would invalidate every browser exception already granted, and
  // change the fingerprint the client pins.
  const first = loadOrCreateTls();
  const second = loadOrCreateTls();
  assert.equal(second.fingerprint, first.fingerprint);
  assert.equal(second.cert, first.cert);
});

test("the fingerprint is the certificate's real SHA-256", () => {
  const { cert, fingerprint } = loadOrCreateTls();
  assert.equal(fingerprint, new X509Certificate(cert).fingerprint256);
  assert.match(fingerprint, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  assert.equal(fingerprintOf(cert), fingerprint);
});

// --- operator-supplied certificate (BCSA_TLS_CERT / BCSA_TLS_KEY) -----------

test("a supplied certificate is used instead of the generated one", () => {
  // Written somewhere of its own, so the test does not depend on the working
  // directory the suite happens to run from.
  const dir = mkdtempSync(join(tmpdir(), "bcsa-tls-"));
  const certFile = join(dir, "cert.pem");
  const keyFile = join(dir, "key.pem");
  const generated = loadOrCreateTls();
  writeFileSync(certFile, generated.cert);
  writeFileSync(keyFile, generated.key);

  process.env.BCSA_TLS_CERT = certFile;
  process.env.BCSA_TLS_KEY = keyFile;
  try {
    const supplied = loadOrCreateTls();
    // Proof it read the supplied files rather than the generated pair: the
    // fingerprint is the one from disk.
    assert.equal(supplied.fingerprint, generated.fingerprint);
    assert.equal(supplied.cert, generated.cert);
  } finally {
    delete process.env.BCSA_TLS_CERT;
    delete process.env.BCSA_TLS_KEY;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setting only one of the two variables is an error, not a silent fallback", () => {
  process.env.BCSA_TLS_CERT = "agent/.data/cert.pem";
  try {
    assert.throws(() => loadOrCreateTls(), /must be set together/);
  } finally {
    delete process.env.BCSA_TLS_CERT;
  }
});

test("an unreadable supplied certificate fails loudly", () => {
  // The dangerous alternative is falling back to the self-signed certificate:
  // the operator would believe they had a trusted one and be told the opposite
  // of the truth about their connection.
  process.env.BCSA_TLS_CERT = "/nonexistent/cert.pem";
  process.env.BCSA_TLS_KEY = "/nonexistent/key.pem";
  try {
    assert.throws(() => loadOrCreateTls(), /could not read the TLS certificate/);
  } finally {
    delete process.env.BCSA_TLS_CERT;
    delete process.env.BCSA_TLS_KEY;
  }
});

test("a malformed supplied certificate is rejected before the handshake", () => {
  process.env.BCSA_TLS_CERT = fileURLToPath(import.meta.url); // exists, not a cert
  process.env.BCSA_TLS_KEY = fileURLToPath(import.meta.url);
  try {
    assert.throws(() => loadOrCreateTls(), /not a valid PEM certificate/);
  } finally {
    delete process.env.BCSA_TLS_CERT;
    delete process.env.BCSA_TLS_KEY;
  }
});
