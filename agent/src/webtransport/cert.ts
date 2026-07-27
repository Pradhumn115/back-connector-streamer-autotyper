import * as x509 from "@peculiar/x509";
import { webcrypto } from "node:crypto";

/**
 * A short-lived ECDSA certificate for the WebTransport listener, plus the
 * SHA-256 of its DER encoding.
 *
 * ## Why this is separate from the agent's HTTPS certificate
 *
 * A browser will only open a WebTransport session to an untrusted certificate
 * if the page passes `serverCertificateHashes`, and that mechanism has hard
 * requirements the HTTPS certificate does not meet: the key must be ECDSA
 * P-256, and the validity window must be at most 14 days. The HTTPS cert is
 * RSA and long-lived on purpose — the user accepts it once in a browser tab
 * and it keeps working — so the two cannot be the same certificate.
 *
 * The trade is deliberate: this one is never seen by a human and never needs
 * accepting, because the client verifies it by hash. The hash travels over the
 * already-authenticated control channel, so a client that trusts the agent
 * enough to send it a secret is the only one that learns it.
 */
export interface WebtransportCert {
  /** PEM certificate, for the QUIC listener. */
  cert: string;
  /** PEM private key, for the QUIC listener. */
  key: string;
  /** Lowercase hex SHA-256 of the DER certificate, for serverCertificateHashes. */
  hash: string;
  /** When this certificate stops being valid; it must be regenerated before then. */
  notAfter: Date;
}

/**
 * Days of validity.
 *
 * The spec caps `serverCertificateHashes` certificates at 14 days; 13 leaves a
 * margin so an agent left running across a clock change or a slow restart does
 * not hand out a certificate the browser will reject as expired.
 */
const VALIDITY_DAYS = 13;

export async function generateWebtransportCert(): Promise<WebtransportCert> {
  x509.cryptoProvider.set(webcrypto as unknown as Crypto);
  const algorithm = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };
  const keys = await webcrypto.subtle.generateKey(algorithm, true, ["sign", "verify"]);

  const now = new Date();
  // Backdated slightly: a browser on a marginally slower clock would otherwise
  // reject a certificate that is valid but not yet, which is indistinguishable
  // from a broken agent.
  const notBefore = new Date(now.getTime() - 5 * 60_000);
  const notAfter = new Date(now.getTime() + VALIDITY_DAYS * 24 * 3600_000);

  const certificate = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: Date.now().toString(16),
    name: "CN=bcsa-webtransport",
    notBefore,
    notAfter,
    signingAlgorithm: algorithm,
    keys,
    extensions: [
      new x509.SubjectAlternativeNameExtension([
        { type: "dns", value: "localhost" },
        { type: "ip", value: "127.0.0.1" },
      ]),
    ],
  });

  const der = new Uint8Array(certificate.rawData);
  const digest = await webcrypto.subtle.digest("SHA-256", der);
  const hash = Buffer.from(digest).toString("hex");

  const pkcs8 = await webcrypto.subtle.exportKey("pkcs8", keys.privateKey);
  const key =
    "-----BEGIN PRIVATE KEY-----\n" +
    (Buffer.from(pkcs8).toString("base64").match(/.{1,64}/g) ?? []).join("\n") +
    "\n-----END PRIVATE KEY-----\n";

  return { cert: certificate.toString("pem"), key, hash, notAfter };
}
