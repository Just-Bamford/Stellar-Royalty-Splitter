import { jest, describe, test, expect, beforeEach, afterEach } from "@jest/globals";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import request from "supertest";
import StellarSdk from "@stellar/stellar-sdk";

const ENV_KEYS = ["ADMIN_ROTATE_TOKEN", "SERVER_SECRET_KEY", "SIGNING_KEY_FILE"];

let snapshot = {};
let tempDir = null;

beforeEach(() => {
  snapshot = {};
  for (const k of ENV_KEYS) {
    snapshot[k] = process.env[k];
    delete process.env[k];
  }
  tempDir = mkdtempSync(join(tmpdir(), "admin-route-test-"));
});

afterEach(async () => {
  const { _resetSigningKeyState } = await import("../src/signing-key.js");
  _resetSigningKeyState();
  for (const [k, v] of Object.entries(snapshot)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
  jest.resetModules();
});

async function buildAdminApp() {
  const express = (await import("express")).default;
  const { adminRouter } = await import("../src/routes/admin.js");
  const { initializeSigningKey } = await import("../src/signing-key.js");
  await initializeSigningKey();
  const app = express();
  app.use(express.json());
  app.use("/admin", adminRouter);
  app.use((err, _req, res, _next) => {
    res.status(500).json({ error: err.message ?? "Internal server error" });
  });
  return app;
}

describe("POST /admin/rotate-key (#293)", () => {
  test("returns 503 when ADMIN_ROTATE_TOKEN is not configured", async () => {
    const app = await buildAdminApp();
    const res = await request(app)
      .post("/admin/rotate-key")
      .set("Authorization", "Bearer anything")
      .send({ secretKey: StellarSdk.Keypair.random().secret() });

    expect(res.status).toBe(503);
  });

  test("returns 401 for missing or invalid bearer token", async () => {
    process.env.ADMIN_ROTATE_TOKEN = "admin-secret";
    const app = await buildAdminApp();
    const secret = StellarSdk.Keypair.random().secret();

    const missing = await request(app)
      .post("/admin/rotate-key")
      .send({ secretKey: secret });
    expect(missing.status).toBe(401);

    const invalid = await request(app)
      .post("/admin/rotate-key")
      .set("Authorization", "Bearer wrong")
      .send({ secretKey: secret });
    expect(invalid.status).toBe(401);
  });

  test("rotates key when authorized with secretKey body", async () => {
    process.env.ADMIN_ROTATE_TOKEN = "admin-secret";
    const initial = StellarSdk.Keypair.random();
    const rotated = StellarSdk.Keypair.random();
    process.env.SERVER_SECRET_KEY = initial.secret();

    const app = await buildAdminApp();
    const res = await request(app)
      .post("/admin/rotate-key")
      .set("Authorization", "Bearer admin-secret")
      .send({ secretKey: rotated.secret() });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      publicKey: rotated.publicKey(),
      source: "api",
      rotatedAt: expect.any(String),
    });

    const { getSigningPublicKey } = await import("../src/signing-key.js");
    expect(getSigningPublicKey()).toBe(rotated.publicKey());
  });

  test("reloads key from SIGNING_KEY_FILE when reloadFromFile is true", async () => {
    process.env.ADMIN_ROTATE_TOKEN = "admin-secret";
    const first = StellarSdk.Keypair.random();
    const second = StellarSdk.Keypair.random();
    const filePath = join(tempDir, "signing.key");
    writeFileSync(filePath, first.secret());
    process.env.SIGNING_KEY_FILE = filePath;

    const app = await buildAdminApp();
    writeFileSync(filePath, second.secret());

    const res = await request(app)
      .post("/admin/rotate-key")
      .set("Authorization", "Bearer admin-secret")
      .send({ reloadFromFile: true });

    expect(res.status).toBe(200);
    expect(res.body.publicKey).toBe(second.publicKey());
    expect(res.body.source).toBe("file_reload");
  });

  test("returns 400 when body omits secretKey and reloadFromFile", async () => {
    process.env.ADMIN_ROTATE_TOKEN = "admin-secret";
    const app = await buildAdminApp();

    const res = await request(app)
      .post("/admin/rotate-key")
      .set("Authorization", "Bearer admin-secret")
      .send({});

    expect(res.status).toBe(400);
  });
});
