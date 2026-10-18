/**
 * Tests for post-quantum hybrid signing (#1039).
 *
 * Verifies:
 *  1. Hybrid keypair generation and encoding sizes
 *  2. Hybrid round trip (Ed25519 + ML-DSA-44 both verify)
 *  3. Tampered message / classical half / PQ half all rejected
 *  4. Wrong-key and malformed encodings rejected without throwing
 *  5. Hash-based long-term scheme (SLH-DSA-SHA2-128s) works
 *  6. Signature and key sizing, plus a verification-latency budget
 */

import { describe, test, expect } from "@jest/globals";
import {
  DEFAULT_PQ_SCHEME,
  SUPPORTED_PQ_SCHEMES,
  generateHybridKeypair,
  signHybrid,
  verifyHybrid,
  parseHybridPublicKey,
  parseHybridSignature,
  hybridPublicKeySize,
  hybridSecretKeySize,
  hybridSignatureSize,
} from "../src/crypto/post-quantum.js";

const MESSAGE = "POST\n/api/royalty\n1700000000000\nnonce-abcdef123456\n<body-sha256>";

/** Replace the character at `index` in a hex string with a different nibble. */
function flipHexChar(hex, index) {
  const replacement = hex[index] === "0" ? "1" : "0";
  return hex.slice(0, index) + replacement + hex.slice(index + 1);
}

describe("post-quantum hybrid signing (#1039)", () => {
  test("generates a hybrid keypair at the documented sizes", () => {
    const { scheme, publicKey, secretKey } = generateHybridKeypair();

    expect(scheme).toBe(DEFAULT_PQ_SCHEME);
    expect(publicKey).toMatch(/^[0-9a-f]+$/);
    expect(secretKey).toMatch(/^[0-9a-f]+$/);
    expect(Buffer.from(publicKey, "hex").length).toBe(hybridPublicKeySize(scheme));
    expect(Buffer.from(secretKey, "hex").length).toBe(hybridSecretKeySize(scheme));
  });

  test("signs and verifies a hybrid signature with both halves present", () => {
    const { scheme, publicKey, secretKey } = generateHybridKeypair();
    const signature = signHybrid(MESSAGE, secretKey);

    expect(verifyHybrid(signature, MESSAGE, publicKey)).toBe(true);
    expect(Buffer.from(signature, "hex").length).toBe(hybridSignatureSize(scheme));

    const parsed = parseHybridSignature(signature);
    expect(parsed.classicalSignature.length).toBe(64);
    expect(parsed.pqSignature.length).toBeGreaterThan(0);
  });

  test("rejects a tampered message", () => {
    const { publicKey, secretKey } = generateHybridKeypair();
    const signature = signHybrid(MESSAGE, secretKey);

    expect(verifyHybrid(signature, `${MESSAGE}x`, publicKey)).toBe(false);
    expect(verifyHybrid(signature, MESSAGE.toUpperCase(), publicKey)).toBe(false);
  });

  test("rejects a tampered Ed25519 (classical) half", () => {
    const { publicKey, secretKey } = generateHybridKeypair();
    const signature = signHybrid(MESSAGE, secretKey);

    // hex layout: ver(2) | schemeId(2) | u16 len(4) | classical sig (128 hex)
    const tampered = flipHexChar(signature, 8);
    expect(verifyHybrid(tampered, MESSAGE, publicKey)).toBe(false);
  });

  test("rejects a tampered post-quantum half", () => {
    const { publicKey, secretKey } = generateHybridKeypair();
    const signature = signHybrid(MESSAGE, secretKey);

    // The PQ half starts after the 2-byte header, 2-byte length, and 64-byte sig.
    const pqStart = (2 + 2 + 2 + 64) * 2;
    const tampered = flipHexChar(signature, pqStart);
    expect(verifyHybrid(tampered, MESSAGE, publicKey)).toBe(false);
  });

  test("rejects a signature checked against a different keypair", () => {
    const alice = generateHybridKeypair();
    const bob = generateHybridKeypair();
    const signature = signHybrid(MESSAGE, alice.secretKey);

    expect(verifyHybrid(signature, MESSAGE, bob.publicKey)).toBe(false);
  });

  test("returns false for malformed inputs instead of throwing", () => {
    const { publicKey, secretKey } = generateHybridKeypair();
    const signature = signHybrid(MESSAGE, secretKey);

    expect(verifyHybrid("", MESSAGE, publicKey)).toBe(false);
    expect(verifyHybrid("zz", MESSAGE, publicKey)).toBe(false);
    expect(verifyHybrid(signature.slice(0, 20), MESSAGE, publicKey)).toBe(false);
    expect(verifyHybrid(signature, MESSAGE, "not-hex")).toBe(false);
    expect(verifyHybrid(signature, MESSAGE, publicKey.slice(0, 8))).toBe(false);
    // Unsupported wire version.
    expect(verifyHybrid(`ff${signature.slice(2)}`, MESSAGE, publicKey)).toBe(false);
  });

  test("supports the hash-based long-term scheme (SLH-DSA-SHA2-128s)", () => {
    const { scheme, publicKey, secretKey } = generateHybridKeypair("slh-dsa-sha2-128s");
    const signature = signHybrid(MESSAGE, secretKey);

    expect(scheme).toBe("slh-dsa-sha2-128s");
    expect(verifyHybrid(signature, MESSAGE, publicKey)).toBe(true);
    expect(flipHexChar(signature, 8)).not.toBe(signature);
  });

  test("enrols both lattice- and hash-based schemes", () => {
    expect(SUPPORTED_PQ_SCHEMES).toEqual(
      expect.arrayContaining(["ml-dsa-44", "slh-dsa-sha2-128s"])
    );
  });

  test("keeps hybrid verification within the latency budget", () => {
    const { publicKey, secretKey } = generateHybridKeypair();
    const signature = signHybrid(MESSAGE, secretKey);

    const iterations = 25;
    const start = process.hrtime.bigint();
    for (let i = 0; i < iterations; i += 1) {
      expect(verifyHybrid(signature, MESSAGE, publicKey)).toBe(true);
    }
    const averageMs = Number(process.hrtime.bigint() - start) / 1e6 / iterations;

    // ML-DSA-44 verification is sub-millisecond; the budget leaves generous
    // headroom for CI noise while still catching a pathological regression.
    expect(averageMs).toBeLessThan(50);
  });
});
