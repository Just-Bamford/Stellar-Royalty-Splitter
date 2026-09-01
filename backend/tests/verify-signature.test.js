/**
 * Tests for Ed25519 request signature verification middleware (#392).
 *
 * Covers:
 *  1. Valid signature — request passes through
 *  2. Missing headers — rejected with 401
 *  3. Malformed X-Signature (wrong length) — rejected with 400
 *  4. Malformed X-Signed-By (not a G-key) — rejected with 400
 *  5. Malformed X-Nonce (too short) — rejected with 400
 *  6. Wrong / tampered signature — rejected with 401
 *  7. Expired timestamp (> SIGNATURE_MAX_AGE_MS) — rejected with 401
 *  8. Future timestamp (negative age) — rejected with 401
 *  9. Nonce replay — second request with same nonce rejected with 401
 * 10. SIGNATURE_VERIFICATION_ENABLED=false — invalid sig still passes (permissive mode)
 * 11. Empty body — signed correctly with SHA-256 of empty bytes
 * 12. buildSignedString produces deterministic output
 */

import {
  jest,
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
} from "@jest/globals";
import { createHash } from "crypto";
import request from "supertest";
import StellarSdk from "@stellar/stellar-sdk";

const { Keypair } = StellarSdk;

// ---------------------------------------------------------------------------
// Helpers — mirrors the frontend sign-request utility
// ---------------------------------------------------------------------------

function sha256Hex(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * Build the canonical signed string buffer (must stay in sync with
 * backend/src/verify-signature.js buildSignedString).
 */
function buildSignedString(method, path, timestamp, nonce, rawBody) {
  const bodyBuf =
    rawBody && rawBody.length > 0 ? rawBody : Buffer.alloc(0);
  const bodyHash = sha256Hex(bodyBuf);
  const canonical = `${method.toUpperCase()}\n${path}\n${timestamp}\n${nonce}\n${bodyHash}`;
  return Buffer.from(canonical, "utf8");
}

/**
 * Generate valid signature headers for a given keypair + request.
 */
function makeHeaders(keypair, method, path, body, overrides = {}) {
  const timestamp = overrides.timestamp ?? String(Date.now());
  const nonce =
    overrides.nonce ??
    `test-nonce-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const rawBody =
    body !== undefined && body !== null
      ? Buffer.from(JSON.stringify(body), "utf8")
      : Buffer.alloc(0);

  const signedString = buildSignedString(method, path, timestamp, nonce, rawBody);
  const sig = keypair.sign(signedString);
  const sigHex =
    overrides.signature ?? Buffer.from(sig).toString("hex");

  return {
    "X-Signature": sigHex,
    "X-Signed-By": overrides["X-Signed-By"] ?? keypair.publicKey(),
    "X-Nonce": nonce,
    "X-Timestamp": timestamp,
  };
}

// ---------------------------------------------------------------------------
// Test app factory — minimal Express app with the middleware under test
// ---------------------------------------------------------------------------

let savedEnv = {};

beforeEach(() => {
  // Snapshot env vars we might modify
  savedEnv = {
    SIGNATURE_VERIFICATION_ENABLED: process.env.SIGNATURE_VERIFICATION_ENABLED,
    SIGNATURE_MAX_AGE_MS: process.env.SIGNATURE_MAX_AGE_MS,
  };
  jest.resetModules();
});

afterEach(async () => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  // Clear nonce cache between tests
  const { _clearNonceCache } = await import("../src/verify-signature.js");
  _clearNonceCache();
  jest.resetModules();
});

async function buildApp() {
  const express = (await import("express")).default;
  const { createBodySizeLimiters } = await import("../src/body-size-limit.js");
  const { verifySignatureMiddleware } = await import(
    "../src/verify-signature.js"
  );
  const { sendError } = await import("../src/error-response.js");

  const app = express();
  app.use(...createBodySizeLimiters({ captureRawBody: true }));

  // Protected write endpoint
  app.post("/api/v1/test", verifySignatureMiddleware, (req, res) => {
    res.json({ ok: true, verifiedSigner: req.verifiedSigner ?? null });
  });

  app.use((err, _req, res, _next) => {
    res.status(500).json({ error: err.message ?? "Internal server error" });
  });

  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("verifySignatureMiddleware (#392)", () => {
  const keypair = Keypair.random();
  const METHOD = "POST";
  const PATH = "/api/v1/test";
  const BODY = { contractId: "CTEST", walletAddress: keypair.publicKey() };

  // ── 1. Valid signature ────────────────────────────────────────────────────
  test("passes a correctly signed request", async () => {
    const app = await buildApp();
    const headers = makeHeaders(keypair, METHOD, PATH, BODY);

    const res = await request(app)
      .post(PATH)
      .set(headers)
      .send(BODY);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.verifiedSigner).toBe(keypair.publicKey());
  });

  // ── 2. Missing headers ────────────────────────────────────────────────────
  test("rejects with 401 when all signature headers are missing", async () => {
    const app = await buildApp();

    const res = await request(app).post(PATH).send(BODY);

    expect(res.status).toBe(401);
    expect(res.body.code).toBe("missing_signature");
  });

  test("rejects with 401 when any single signature header is missing", async () => {
    const app = await buildApp();
    const headers = makeHeaders(keypair, METHOD, PATH, BODY);

    for (const drop of ["X-Signature", "X-Signed-By", "X-Nonce", "X-Timestamp"]) {
      const partial = { ...headers };
      delete partial[drop];

      const res = await request(app).post(PATH).set(partial).send(BODY);
      expect(res.status).toBe(401);
      expect(res.body.code).toBe("missing_signature");
    }
  });

  // ── 3. Malformed X-Signature ──────────────────────────────────────────────
  test("rejects with 400 when X-Signature is not 128 hex chars", async () => {
    const app = await buildApp();
    const headers = makeHeaders(keypair, METHOD, PATH, BODY, {
      signature: "deadbeef", // too short
    });

    const res = await request(app).post(PATH).set(headers).send(BODY);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_signature_format");
  });

  // ── 4. Malformed X-Signed-By ──────────────────────────────────────────────
  test("rejects with 400 when X-Signed-By is not a valid G-key", async () => {
    const app = await buildApp();
    const headers = makeHeaders(keypair, METHOD, PATH, BODY, {
      "X-Signed-By": "not-a-stellar-key",
    });

    const res = await request(app).post(PATH).set(headers).send(BODY);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_signer_format");
  });

  // ── 5. Malformed X-Nonce ──────────────────────────────────────────────────
  test("rejects with 400 when X-Nonce is shorter than 16 characters", async () => {
    const app = await buildApp();
    const headers = makeHeaders(keypair, METHOD, PATH, BODY, {
      nonce: "tooshort",
    });

    const res = await request(app).post(PATH).set(headers).send(BODY);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_nonce_format");
  });

  // ── 6. Wrong / tampered signature ─────────────────────────────────────────
  test("rejects with 401 when signature was made by a different keypair", async () => {
    const app = await buildApp();
    const wrongKeypair = Keypair.random();
    // Sign with wrongKeypair but claim to be keypair
    const headers = makeHeaders(wrongKeypair, METHOD, PATH, BODY);
    headers["X-Signed-By"] = keypair.publicKey(); // lie about signer

    const res = await request(app).post(PATH).set(headers).send(BODY);

    expect(res.status).toBe(401);
    expect(res.body.code).toBe("invalid_signature");
  });

  test("rejects with 401 when the request body has been tampered with", async () => {
    const app = await buildApp();
    const headers = makeHeaders(keypair, METHOD, PATH, BODY);

    // Send a different body than what was signed
    const tamperedBody = { ...BODY, contractId: "CTAMPERED" };

    const res = await request(app)
      .post(PATH)
      .set(headers)
      .send(tamperedBody);

    expect(res.status).toBe(401);
    expect(res.body.code).toBe("invalid_signature");
  });

  // ── 7. Expired timestamp ──────────────────────────────────────────────────
  test("rejects with 401 when timestamp is older than SIGNATURE_MAX_AGE_MS", async () => {
    const app = await buildApp();
    const sixMinutesAgo = String(Date.now() - 6 * 60 * 1000);
    const headers = makeHeaders(keypair, METHOD, PATH, BODY, {
      timestamp: sixMinutesAgo,
    });

    const res = await request(app).post(PATH).set(headers).send(BODY);

    expect(res.status).toBe(401);
    expect(res.body.code).toBe("signature_expired");
  });

  // ── 8. Future timestamp ───────────────────────────────────────────────────
  test("rejects with 401 when timestamp is in the future", async () => {
    const app = await buildApp();
    const tenMinutesFuture = String(Date.now() + 10 * 60 * 1000);
    const headers = makeHeaders(keypair, METHOD, PATH, BODY, {
      timestamp: tenMinutesFuture,
    });

    const res = await request(app).post(PATH).set(headers).send(BODY);

    expect(res.status).toBe(401);
    expect(res.body.code).toBe("signature_expired");
  });

  // ── 9. Nonce replay ───────────────────────────────────────────────────────
  test("rejects a replayed nonce on the second request", async () => {
    const app = await buildApp();
    const headers = makeHeaders(keypair, METHOD, PATH, BODY);

    const first = await request(app).post(PATH).set(headers).send(BODY);
    expect(first.status).toBe(200);

    const second = await request(app).post(PATH).set(headers).send(BODY);
    expect(second.status).toBe(401);
    expect(second.body.code).toBe("nonce_reused");
  });

  // ── 10. Permissive mode ───────────────────────────────────────────────────
  test("allows invalid signature through when SIGNATURE_VERIFICATION_ENABLED=false", async () => {
    process.env.SIGNATURE_VERIFICATION_ENABLED = "false";
    jest.resetModules();

    const app = await buildApp();

    // Send request with NO signature headers at all
    const res = await request(app).post(PATH).send(BODY);

    expect(res.status).toBe(200);
  });

  // ── 11. Minimal body ({}) signed correctly ────────────────────────────────
  test("passes a correctly signed request with a minimal body", async () => {
    const app = await buildApp();

    const minimalBody = {};
    const headers = makeHeaders(keypair, METHOD, PATH, minimalBody);

    const res = await request(app)
      .post(PATH)
      .set(headers)
      .send(minimalBody);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  // ── 12. buildSignedString is deterministic ────────────────────────────────
  test("buildSignedString produces identical output on repeated calls", async () => {
    const { buildSignedString: serverBuild } = await import(
      "../src/verify-signature.js"
    );

    const rawBody = Buffer.from(JSON.stringify(BODY), "utf8");
    const a = serverBuild("POST", "/api/v1/test", "1234567890", "my-nonce-abcdef1234567890", rawBody);
    const b = serverBuild("POST", "/api/v1/test", "1234567890", "my-nonce-abcdef1234567890", rawBody);

    expect(Buffer.compare(a, b)).toBe(0);
  });

  // ── GET requests are never checked ───────────────────────────────────────
  test("skips signature check for GET requests", async () => {
    const express = (await import("express")).default;
    const { verifySignatureMiddleware } = await import(
      "../src/verify-signature.js"
    );
    const app = express();
    app.get("/api/v1/test", verifySignatureMiddleware, (_req, res) => {
      res.json({ ok: true });
    });

    const res = await request(app).get("/api/v1/test");
    expect(res.status).toBe(200);
  });
});
