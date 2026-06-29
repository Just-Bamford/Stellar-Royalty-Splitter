import { describe, test, expect, beforeEach } from "@jest/globals";
import { randomUUID } from "crypto";
import express from "express";
import request from "supertest";
import StellarSdk from "@stellar/stellar-sdk";
import {
  buildSignedRequestPayload,
  resetRequestSignatureNonces,
  verifySignedWriteRequest,
} from "../src/request-signature.js";

const { Keypair } = StellarSdk;

function createApp() {
  const app = express();
  app.use(express.json());
  app.post("/protected", verifySignedWriteRequest, (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

function signHeaders({
  keypair,
  path = "/protected",
  body,
  timestamp = Date.now().toString(),
  nonce = randomUUID(),
}) {
  const payload = buildSignedRequestPayload({
    method: "POST",
    path,
    timestamp,
    nonce,
    body,
  });
  const signature = keypair.sign(Buffer.from(payload, "utf8")).toString("base64");

  return {
    "x-srs-public-key": keypair.publicKey(),
    "x-srs-signature": signature,
    "x-srs-timestamp": timestamp,
    "x-srs-nonce": nonce,
  };
}

describe("request signature middleware (#497)", () => {
  const app = createApp();

  beforeEach(() => {
    resetRequestSignatureNonces();
  });

  test("accepts a valid signed write request", async () => {
    const keypair = Keypair.random();
    const body = { walletAddress: keypair.publicKey(), amount: 100 };

    const res = await request(app)
      .post("/protected")
      .set(signHeaders({ keypair, body }))
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  test("rejects unsigned write requests", async () => {
    const res = await request(app)
      .post("/protected")
      .send({ amount: 100 });

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/missing request signature/i);
  });

  test("rejects tampered request bodies", async () => {
    const keypair = Keypair.random();
    const signedBody = { walletAddress: keypair.publicKey(), amount: 100 };
    const tamperedBody = { walletAddress: keypair.publicKey(), amount: 999 };

    const res = await request(app)
      .post("/protected")
      .set(signHeaders({ keypair, body: signedBody }))
      .send(tamperedBody);

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/invalid request signature/i);
  });

  test("rejects replayed nonces", async () => {
    const keypair = Keypair.random();
    const body = { walletAddress: keypair.publicKey(), amount: 100 };
    const nonce = randomUUID();
    const headers = signHeaders({ keypair, body, nonce });

    await request(app).post("/protected").set(headers).send(body);
    const replay = await request(app).post("/protected").set(headers).send(body);

    expect(replay.status).toBe(401);
    expect(replay.body.error).toMatch(/nonce has already been used/i);
  });

  test("rejects expired timestamps", async () => {
    const keypair = Keypair.random();
    const body = { walletAddress: keypair.publicKey(), amount: 100 };
    const timestamp = (Date.now() - 10 * 60 * 1000).toString();

    const res = await request(app)
      .post("/protected")
      .set(signHeaders({ keypair, body, timestamp }))
      .send(body);

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/timestamp/i);
  });

  test("rejects signatures from a different walletAddress", async () => {
    const signer = Keypair.random();
    const wallet = Keypair.random();
    const body = { walletAddress: wallet.publicKey(), amount: 100 };

    const res = await request(app)
      .post("/protected")
      .set(signHeaders({ keypair: signer, body }))
      .send(body);

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/does not match walletAddress/i);
  });

  test("rejects malformed signer public keys", async () => {
    const keypair = Keypair.random();
    const body = { amount: 100 };
    const headers = {
      ...signHeaders({ keypair, body }),
      "x-srs-public-key": "not-a-stellar-public-key",
    };

    const res = await request(app).post("/protected").set(headers).send(body);

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/invalid request signer/i);
  });
});
