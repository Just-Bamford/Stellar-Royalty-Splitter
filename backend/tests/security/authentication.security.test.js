/**
 * OWASP A07:2021 — Identification and Authentication Failures
 *
 * Exercises the real Ed25519 request-signing verifier in
 * src/verify-signature.js: signature forgery, replay, expiry, and
 * tampering with the signed material after signing.
 *
 * Signatures here are produced with a real Stellar keypair, so removing the
 * `keypair.verify()` call, the nonce cache, or the timestamp window makes
 * these fail deterministically.
 */
import { Keypair } from "@stellar/stellar-sdk";
import {
  verifyRequestSignature,
  buildSignedString,
  _clearNonceCache,
  SIGNATURE_MAX_AGE_MS,
} from "../../src/verify-signature.js";

const METHOD = "POST";
const PATH = "/api/v1/distribute";
const BODY = JSON.stringify({ amount: "100" });

let signer;
let nonceCounter = 0;

function uniqueNonce() {
  nonceCounter += 1;
  return `nonce-${nonceCounter}-${Math.random().toString(16).slice(2)}`;
}

/** Build a fully valid signed request, allowing individual fields to be overridden. */
function signedRequest(overrides = {}) {
  const now = overrides.now ?? Date.now();
  const timestamp = String(overrides.timestamp ?? now);
  const nonce = overrides.nonce ?? uniqueNonce();
  const rawBody = overrides.rawBody ?? BODY;
  const method = overrides.method ?? METHOD;
  const path = overrides.path ?? PATH;

  const signedString = buildSignedString(method, path, timestamp, nonce, rawBody);
  const signature = (overrides.signWith ?? signer).sign(signedString).toString("hex");

  return {
    method,
    path,
    signedBy: overrides.signedBy ?? signer.publicKey(),
    signature: overrides.signature ?? signature,
    nonce,
    timestamp,
    tsNum: Number(timestamp),
    rawBody,
    now,
  };
}

beforeEach(() => {
  _clearNonceCache();
  signer = Keypair.random();
});

describe("Security — OWASP A07 Authentication Failures", () => {
  test("a correctly signed request is accepted", () => {
    expect(verifyRequestSignature(signedRequest()).ok).toBe(true);
  });

  describe("forged signatures are rejected", () => {
    test("a signature from a different keypair is rejected", () => {
      const attacker = Keypair.random();
      const req = signedRequest({ signWith: attacker });
      // Signed by the attacker but claiming to be the legitimate signer.
      const result = verifyRequestSignature(req);
      expect(result.ok).toBe(false);
    });

    test("an all-zero signature is rejected", () => {
      const req = signedRequest({ signature: "00".repeat(64) });
      expect(verifyRequestSignature(req).ok).toBe(false);
    });

    test.each([
      ["not-hex-at-all", "non-hex characters"],
      ["", "empty signature"],
      ["ab", "truncated signature"],
    ])("malformed signature %j (%s) is rejected", (signature) => {
      const req = signedRequest({ signature });
      expect(verifyRequestSignature(req).ok).toBe(false);
    });

    test("an invalid public key is rejected without throwing", () => {
      const req = signedRequest({ signedBy: "' OR 1=1 --" });
      const result = verifyRequestSignature(req);
      expect(result.ok).toBe(false);
      expect(result.code).toBe("invalid_public_key");
    });
  });

  describe("tampering after signing is detected", () => {
    test("modifying the body invalidates the signature", () => {
      const req = signedRequest();
      req.rawBody = JSON.stringify({ amount: "999999999" });
      expect(verifyRequestSignature(req).ok).toBe(false);
    });

    test("modifying the path invalidates the signature", () => {
      const req = signedRequest();
      req.path = "/api/v1/admin/rotate-key";
      expect(verifyRequestSignature(req).ok).toBe(false);
    });

    test("modifying the method invalidates the signature", () => {
      const req = signedRequest();
      req.method = "DELETE";
      expect(verifyRequestSignature(req).ok).toBe(false);
    });

    test("modifying the nonce invalidates the signature", () => {
      const req = signedRequest();
      req.nonce = uniqueNonce();
      expect(verifyRequestSignature(req).ok).toBe(false);
    });
  });

  describe("replay protection", () => {
    test("replaying an identical signed request is rejected as nonce reuse", () => {
      const req = signedRequest();
      expect(verifyRequestSignature(req).ok).toBe(true);

      const replay = verifyRequestSignature({ ...req });
      expect(replay.ok).toBe(false);
      expect(replay.code).toBe("nonce_reused");
    });

    test("a fresh nonce from the same signer is still accepted", () => {
      expect(verifyRequestSignature(signedRequest()).ok).toBe(true);
      expect(verifyRequestSignature(signedRequest()).ok).toBe(true);
    });
  });

  describe("timestamp window", () => {
    test("a stale request outside the max-age window is rejected", () => {
      const now = Date.now();
      const stale = signedRequest({ timestamp: now - SIGNATURE_MAX_AGE_MS - 60_000, now });
      const result = verifyRequestSignature(stale);
      expect(result.ok).toBe(false);
      expect(result.code).toBe("signature_expired");
    });

    test("a far-future timestamp is rejected", () => {
      const now = Date.now();
      const future = signedRequest({ timestamp: now + 60 * 60 * 1000, now });
      const result = verifyRequestSignature(future);
      expect(result.ok).toBe(false);
      expect(result.code).toBe("signature_expired");
    });
  });

  test("failure responses never leak key material or internals", () => {
    const attacker = Keypair.random();
    const result = verifyRequestSignature(signedRequest({ signWith: attacker }));

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(signer.secret());
    expect(serialized).not.toContain(attacker.secret());
    expect(serialized).not.toMatch(/stack|node_modules|at Object\./i);
  });
});
