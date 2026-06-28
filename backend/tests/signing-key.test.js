import { jest, describe, test, expect, beforeEach, afterEach } from "@jest/globals";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import StellarSdk from "@stellar/stellar-sdk";

const ENV_KEYS = ["SERVER_SECRET_KEY", "SIGNING_KEY_FILE", "ADMIN_ROTATE_TOKEN"];

let snapshot = {};
let tempDir = null;

beforeEach(() => {
  snapshot = {};
  for (const k of ENV_KEYS) {
    snapshot[k] = process.env[k];
    delete process.env[k];
  }
  tempDir = mkdtempSync(join(tmpdir(), "signing-key-test-"));
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
});

describe("signing-key (#293)", () => {
  test("loads key from SERVER_SECRET_KEY", async () => {
    const kp = StellarSdk.Keypair.random();
    process.env.SERVER_SECRET_KEY = kp.secret();

    const { initializeSigningKey, getSigningPublicKey } = await import(
      "../src/signing-key.js"
    );
    await initializeSigningKey();

    expect(getSigningPublicKey()).toBe(kp.publicKey());
  });

  test("SIGNING_KEY_FILE takes precedence over env", async () => {
    const fileKp = StellarSdk.Keypair.random();
    const envKp = StellarSdk.Keypair.random();
    const filePath = join(tempDir, "signing.key");
    writeFileSync(filePath, fileKp.secret());
    process.env.SIGNING_KEY_FILE = filePath;
    process.env.SERVER_SECRET_KEY = envKp.secret();

    const { initializeSigningKey, getSigningPublicKey } = await import(
      "../src/signing-key.js"
    );
    await initializeSigningKey();

    expect(getSigningPublicKey()).toBe(fileKp.publicKey());
  });

  test("rotateSigningKey updates in-memory public key", async () => {
    const first = StellarSdk.Keypair.random();
    const second = StellarSdk.Keypair.random();
    process.env.SERVER_SECRET_KEY = first.secret();

    const { initializeSigningKey, rotateSigningKey, getSigningPublicKey } =
      await import("../src/signing-key.js");
    await initializeSigningKey();
    const result = rotateSigningKey(second.secret(), { source: "api" });

    expect(result.publicKey).toBe(second.publicKey());
    expect(getSigningPublicKey()).toBe(second.publicKey());
  });

  test("reloadSigningKeyFromSecretsFile reads updated file contents", async () => {
    const first = StellarSdk.Keypair.random();
    const second = StellarSdk.Keypair.random();
    const filePath = join(tempDir, "signing.key");
    writeFileSync(filePath, first.secret());
    process.env.SIGNING_KEY_FILE = filePath;

    const {
      initializeSigningKey,
      reloadSigningKeyFromSecretsFile,
      getSigningPublicKey,
    } = await import("../src/signing-key.js");
    await initializeSigningKey();
    expect(getSigningPublicKey()).toBe(first.publicKey());

    writeFileSync(filePath, second.secret());
    const result = reloadSigningKeyFromSecretsFile();

    expect(result.publicKey).toBe(second.publicKey());
    expect(result.source).toBe("file_reload");
  });

  test("isAdminRotateTokenValid uses constant-time comparison", async () => {
    process.env.ADMIN_ROTATE_TOKEN = "rotate-token-secret";
    const { isAdminRotateTokenValid } = await import("../src/signing-key.js");

    expect(isAdminRotateTokenValid("rotate-token-secret")).toBe(true);
    expect(isAdminRotateTokenValid("wrong-token")).toBe(false);
    expect(isAdminRotateTokenValid("")).toBe(false);
  });

  test("parseSigningSecret rejects invalid secrets", async () => {
    const { parseSigningSecret } = await import("../src/signing-key.js");
    expect(() => parseSigningSecret("not-a-key")).toThrow(/Signing secret key must start/);
  });
});
