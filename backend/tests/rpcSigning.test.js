import { jest, describe, test, expect, beforeAll, afterAll } from "@jest/globals";

await jest.unstable_mockModule("../src/logger.js", () => ({
  default: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

// Use a well-known testnet keypair (never used for real funds)
const TEST_SECRET = "SCZANGBA5RLZWHEUIZRTLBOAMHCTNBNE22GKFRP4LUGMS3U5TZLTNMH";
const TEST_PUBLIC = "GD2AVIZF6KZXS5LFVBKUUHYUQFZ5H6V7HXBHQVMBYQNPTCGCQPKQXE";

describe("rpcSigning (disabled by default)", () => {
  let mod;

  beforeAll(async () => {
    delete process.env.SOROBAN_RPC_SIGNING_ENABLED;
    delete process.env.SERVER_SECRET_KEY;
    mod = await import("../src/rpcSigning.js");
  });

  test("isSigningEnabled() returns false when env not set", () => {
    expect(mod.isSigningEnabled()).toBe(false);
  });

  test("buildSigningHeaders() returns empty object when disabled", () => {
    const headers = mod.buildSigningHeaders({ foo: "bar" });
    expect(headers).toEqual({});
  });

  test("verifyResponseSignature() returns true when disabled (no check needed)", () => {
    expect(mod.verifyResponseSignature("sig", "ts", "body", TEST_PUBLIC)).toBe(true);
  });

  test("signedFetch() delegates directly to global fetch when disabled", async () => {
    const fakeFetch = jest.fn().mockResolvedValue({ ok: true });
    const original = global.fetch;
    global.fetch = fakeFetch;
    await mod.signedFetch("http://example.com", { method: "POST", body: "data" });
    expect(fakeFetch).toHaveBeenCalledWith("http://example.com", expect.objectContaining({ method: "POST" }));
    global.fetch = original;
  });
});

describe("rpcSigning (enabled)", () => {
  let mod;

  beforeAll(async () => {
    // Reload module with signing enabled
    jest.resetModules();
    process.env.SOROBAN_RPC_SIGNING_ENABLED = "true";
    process.env.SERVER_SECRET_KEY = TEST_SECRET;

    // Re-mock logger after resetModules
    await jest.unstable_mockModule("../src/logger.js", () => ({
      default: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
    }));
    mod = await import("../src/rpcSigning.js?enabled=1");
  });

  afterAll(() => {
    delete process.env.SOROBAN_RPC_SIGNING_ENABLED;
    delete process.env.SERVER_SECRET_KEY;
  });

  test("buildSigningHeaders() returns signature headers", () => {
    const headers = mod.buildSigningHeaders({ method: "getAccount" });
    expect(headers).toHaveProperty("X-Stellar-Signature");
    expect(headers).toHaveProperty("X-Stellar-Timestamp");
    expect(headers).toHaveProperty("X-Stellar-Public-Key");
    expect(typeof headers["X-Stellar-Signature"]).toBe("string");
    expect(headers["X-Stellar-Signature"].length).toBeGreaterThan(0);
  });

  test("verifyResponseSignature() validates a self-signed body", () => {
    const body = JSON.stringify({ result: "ok" });
    const headers = mod.buildSigningHeaders(body);
    const valid = mod.verifyResponseSignature(
      headers["X-Stellar-Signature"],
      headers["X-Stellar-Timestamp"],
      body,
      headers["X-Stellar-Public-Key"],
    );
    expect(valid).toBe(true);
  });

  test("verifyResponseSignature() rejects a tampered body", () => {
    const originalBody = JSON.stringify({ result: "ok" });
    const headers = mod.buildSigningHeaders(originalBody);
    const valid = mod.verifyResponseSignature(
      headers["X-Stellar-Signature"],
      headers["X-Stellar-Timestamp"],
      JSON.stringify({ result: "tampered" }),
      headers["X-Stellar-Public-Key"],
    );
    expect(valid).toBe(false);
  });

  test("verifyResponseSignature() rejects an old timestamp", () => {
    const body = "body";
    const staleTimestamp = String(Math.floor(Date.now() / 1000) - 120); // 2 min ago
    // Build a valid signature but with a stale timestamp
    const headers = mod.buildSigningHeaders(body);
    const valid = mod.verifyResponseSignature(
      headers["X-Stellar-Signature"],
      staleTimestamp,
      body,
      headers["X-Stellar-Public-Key"],
    );
    expect(valid).toBe(false);
  });

  test("signedFetch() injects signing headers", async () => {
    const fakeFetch = jest.fn().mockResolvedValue({ ok: true });
    const original = global.fetch;
    global.fetch = fakeFetch;

    await mod.signedFetch("http://example.com", {
      method: "POST",
      body: JSON.stringify({ id: 1 }),
    });

    const [, opts] = fakeFetch.mock.calls[0];
    expect(opts.headers).toHaveProperty("X-Stellar-Signature");
    expect(opts.headers).toHaveProperty("X-Stellar-Timestamp");
    global.fetch = original;
  });
});
