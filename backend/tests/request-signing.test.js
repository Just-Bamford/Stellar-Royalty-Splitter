/**
 * Request signing integration tests (issue #392).
 */
import { describe, test, expect, beforeEach, afterEach } from "@jest/globals";
import express from "express";
import request from "supertest";
import StellarSdk from "@stellar/stellar-sdk";
import {
  signRequest,
  verifyRequestSignatureMiddleware,
  buildCanonicalMessage,
  hashRequestBody,
  verifyWalletSignature,
  isRequestSigningRequired,
  _resetNonceCache,
} from "../src/request-signing.js";

const { Keypair } = StellarSdk;
const TEST_KEYPAIR = Keypair.random();
const WALLET_SECRET = TEST_KEYPAIR.secret();
const WALLET_PUBLIC = TEST_KEYPAIR.publicKey();

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use(verifyRequestSignatureMiddleware);
  app.post("/api/v1/initialize", (req, res) => {
    res.json({ ok: true, wallet: req.signedWalletAddress ?? req.body.walletAddress });
  });
  return app;
}

describe("request-signing (issue #392)", () => {
  const originalEnv = process.env.REQUEST_SIGNING_REQUIRED;

  beforeEach(() => {
    _resetNonceCache();
    process.env.REQUEST_SIGNING_REQUIRED = "true";
  });

  afterEach(() => {
    process.env.REQUEST_SIGNING_REQUIRED = originalEnv;
    _resetNonceCache();
  });

  test("request signing is required by default", () => {
    delete process.env.REQUEST_SIGNING_REQUIRED;

    expect(isRequestSigningRequired()).toBe(true);
  });

  test("valid signature is accepted", async () => {
    const app = createTestApp();
    const body = {
      contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      walletAddress: WALLET_PUBLIC,
      collaborators: ["GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"],
      shares: [10000],
    };
    const { headers } = signRequest({
      method: "POST",
      path: "/api/v1/initialize",
      body,
      walletSecret: WALLET_SECRET,
    });

    const res = await request(app)
      .post("/api/v1/initialize")
      .set(headers)
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  test("missing signature headers returns 401 when required", async () => {
    const app = createTestApp();
    const res = await request(app)
      .post("/api/v1/initialize")
      .send({ walletAddress: WALLET_PUBLIC });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe("missing_signature");
  });

  test("invalid signature returns 401", async () => {
    const app = createTestApp();
    const body = { walletAddress: WALLET_PUBLIC };
    const { headers } = signRequest({
      method: "POST",
      path: "/api/v1/initialize",
      body,
      walletSecret: WALLET_SECRET,
    });

    const res = await request(app)
      .post("/api/v1/initialize")
      .set({ ...headers, "X-Signature": Buffer.from("invalid").toString("base64") })
      .send(body);

    expect(res.status).toBe(401);
    expect(res.body.code).toBe("invalid_signature");
  });

  test("expired timestamp returns 401", async () => {
    const app = createTestApp();
    const body = { walletAddress: WALLET_PUBLIC };
    const expiredTs = Math.floor(Date.now() / 1000) - 600;
    const { headers } = signRequest({
      method: "POST",
      path: "/api/v1/initialize",
      body,
      walletSecret: WALLET_SECRET,
      timestamp: expiredTs,
    });

    const res = await request(app)
      .post("/api/v1/initialize")
      .set(headers)
      .send(body);

    expect(res.status).toBe(401);
    expect(res.body.code).toBe("signature_expired");
  });

  test("replay nonce returns 401", async () => {
    const app = createTestApp();
    const body = { walletAddress: WALLET_PUBLIC };
    const { headers } = signRequest({
      method: "POST",
      path: "/api/v1/initialize",
      body,
      walletSecret: WALLET_SECRET,
      nonce: "fixed-nonce-123",
    });

    const first = await request(app).post("/api/v1/initialize").set(headers).send(body);
    expect(first.status).toBe(200);

    const second = await request(app).post("/api/v1/initialize").set(headers).send(body);
    expect(second.status).toBe(401);
    expect(second.body.code).toBe("replay_detected");
  });

  test("wallet mismatch between header and body returns 401", async () => {
    const app = createTestApp();
    const body = {
      walletAddress: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    };
    const { headers } = signRequest({
      method: "POST",
      path: "/api/v1/initialize",
      body,
      walletSecret: WALLET_SECRET,
    });

    const res = await request(app).post("/api/v1/initialize").set(headers).send(body);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("wallet_mismatch");
  });

  test("unsigned requests allowed when signing not required", async () => {
    process.env.REQUEST_SIGNING_REQUIRED = "false";
    const app = createTestApp();
    const res = await request(app)
      .post("/api/v1/initialize")
      .send({ walletAddress: WALLET_PUBLIC });

    expect(res.status).toBe(200);
  });

  test("buildCanonicalMessage and verifyWalletSignature round-trip", () => {
    const bodyHash = hashRequestBody({ foo: "bar" });
    const message = buildCanonicalMessage({
      method: "POST",
      path: "/api/v1/distribute",
      timestamp: 1700000000,
      nonce: "abc",
      bodyHash,
    });
    const { headers } = signRequest({
      method: "POST",
      path: "/api/v1/distribute",
      body: { foo: "bar" },
      walletSecret: WALLET_SECRET,
      timestamp: 1700000000,
      nonce: "abc",
    });
    expect(
      verifyWalletSignature(WALLET_PUBLIC, message, headers["X-Signature"])
    ).toBe(true);
  });

  test("isRequestSigningRequired reflects env", () => {
    process.env.REQUEST_SIGNING_REQUIRED = "true";
    expect(isRequestSigningRequired()).toBe(true);
    process.env.REQUEST_SIGNING_REQUIRED = "false";
    expect(isRequestSigningRequired()).toBe(false);
    delete process.env.REQUEST_SIGNING_REQUIRED;
    expect(isRequestSigningRequired()).toBe(true);
  });
});
