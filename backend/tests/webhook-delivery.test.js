import { jest, describe, test, expect, beforeEach, afterEach } from "@jest/globals";

const listWebhooks = jest.fn();
const updateWebhookRetryStateWithPayload = jest.fn();
const resetWebhookRetryCount = jest.fn();
const moveToDlq = jest.fn();

await jest.unstable_mockModule("../src/database/webhooks.js", () => ({
  listWebhooks,
  updateWebhookRetryStateWithPayload,
  resetWebhookRetryCount,
  moveToDlq,
}));

await jest.unstable_mockModule("../src/database/core.js", () => ({
  db: {
    prepare: () => ({
      run: jest.fn(),
      get: jest.fn(() => null),
      all: () => [],
    }),
  },
}));

await jest.unstable_mockModule("../src/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

describe("deliverDistributeWebhooks (#295)", () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    listWebhooks.mockReset();
    updateWebhookRetryStateWithPayload.mockReset();
    resetWebhookRetryCount.mockReset();
    jest.resetModules();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test("POSTs payload to registered webhooks", async () => {
    listWebhooks.mockReturnValue([
      {
        id: 1,
        url: "https://example.com/hook",
        contractId: "CAAA",
        enabled: 1,
        retry_count: 0,
        next_retry_time: null,
      },
    ]);

    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
    }));

    const { deliverDistributeWebhooks } = await import("../src/webhook-delivery.js");

    deliverDistributeWebhooks({
      txHash: "d".repeat(64),
      contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      tokenId: "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      requestedAmount: "1000",
      status: "confirmed",
      blockTime: "2026-05-31T12:00:00.000Z",
      timestamp: "2026-05-31T12:00:00.000Z",
      payouts: [{ collaboratorAddress: "GAAA", amountReceived: "500" }],
    });

    // Give async operations time to settle
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [, init] = global.fetch.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({
      event: "distribute.confirmed",
      status: "confirmed",
      recipients: [{ address: "GAAA", amount: "500" }],
    });
    expect(resetWebhookRetryCount).toHaveBeenCalledTimes(1);
  });

  test("stores payload and schedules retry on first delivery failure", async () => {
    listWebhooks.mockReturnValue([
      {
        id: 1,
        url: "https://example.com/hook",
        contractId: "CAAA",
        enabled: 1,
        retry_count: 0,
        next_retry_time: null,
      },
    ]);

    global.fetch = jest.fn(async () => ({
      ok: false,
      status: 500,
    }));

    const { deliverDistributeWebhooks } = await import("../src/webhook-delivery.js");

    deliverDistributeWebhooks({
      txHash: "d".repeat(64),
      contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      tokenId: "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      requestedAmount: "1000",
      status: "confirmed",
      blockTime: "2026-05-31T12:00:00.000Z",
      timestamp: "2026-05-31T12:00:00.000Z",
      payouts: [{ collaboratorAddress: "GAAA", amountReceived: "500" }],
    });

    // Give async operations time to settle
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(updateWebhookRetryStateWithPayload).toHaveBeenCalledTimes(1);
    const callArgs = updateWebhookRetryStateWithPayload.mock.calls[0];
    expect(callArgs[0]).toBe(1);
    expect(callArgs[1]).toBeGreaterThan(0);
    expect(callArgs[2]).toBeTruthy(); // nextRetryTime
    const payload = JSON.parse(callArgs[3]);
    expect(payload.event).toBe("distribute.confirmed");
    expect(payload.transactionHash).toBe("d".repeat(64));
  });

  test("resets retry state on successful delivery after previous failures", async () => {
    listWebhooks.mockReturnValue([
      {
        id: 1,
        url: "https://example.com/hook",
        contractId: "CAAA",
        enabled: 1,
        retry_count: 2,
        next_retry_time: "2026-01-01T00:00:00.000Z",
      },
    ]);

    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
    }));

    const { deliverDistributeWebhooks } = await import("../src/webhook-delivery.js");

    deliverDistributeWebhooks({
      txHash: "d".repeat(64),
      contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      tokenId: "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      requestedAmount: "1000",
      status: "confirmed",
      blockTime: "2026-05-31T12:00:00.000Z",
      timestamp: "2026-05-31T12:00:00.000Z",
      payouts: [{ collaboratorAddress: "GAAA", amountReceived: "500" }],
    });

    // Give async operations time to settle
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(resetWebhookRetryCount).toHaveBeenCalledTimes(1);
  });
});

// ── #1141: HMAC signature header tests ──────────────────────────────────────

describe("computeWebhookSignature (#1141)", () => {
  test("produces sha256=<hex> format", async () => {
    const { computeWebhookSignature } = await import("../src/webhook-delivery.js");
    const sig = computeWebhookSignature('{"event":"test"}', "mysecret");
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  test("known-value: signature matches independently computed HMAC", async () => {
    // Independently verify: echo -n '{"event":"test"}' | openssl dgst -sha256 -hmac "mysecret"
    // Node equivalent used here so the test is self-contained.
    const { createHmac } = await import("crypto");
    const { computeWebhookSignature } = await import("../src/webhook-delivery.js");

    const body = '{"event":"distribute.confirmed","contractId":"CAAA"}';
    const secret = "test-secret-1234";
    const expected = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
    expect(computeWebhookSignature(body, secret)).toBe(expected);
  });
});

describe("postWebhook X-Webhook-Signature (#1141)", () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    jest.resetModules();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test("includes X-Webhook-Signature header when secret is provided", async () => {
    global.fetch = jest.fn(async () => ({ ok: true, status: 200 }));

    const { postWebhook, computeWebhookSignature } = await import("../src/webhook-delivery.js");

    const payload = { event: "distribute.confirmed", contractId: "CAAA" };
    const secret = "my-webhook-secret";
    await postWebhook("https://example.com/hook", payload, { secret });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [, init] = global.fetch.mock.calls[0];

    // The body passed to fetch must equal JSON.stringify(payload)
    const expectedBody = JSON.stringify(payload);
    expect(init.body).toBe(expectedBody);

    // The signature must cover the exact body bytes
    const expectedSig = computeWebhookSignature(expectedBody, secret);
    expect(init.headers["X-Webhook-Signature"]).toBe(expectedSig);
    expect(init.headers["X-Webhook-Signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  test("omits X-Webhook-Signature when no secret is provided", async () => {
    global.fetch = jest.fn(async () => ({ ok: true, status: 200 }));

    const { postWebhook } = await import("../src/webhook-delivery.js");

    await postWebhook("https://example.com/hook", { event: "test" });

    const [, init] = global.fetch.mock.calls[0];
    expect(init.headers["X-Webhook-Signature"]).toBeUndefined();
  });

  test("omits X-Webhook-Signature when secret is null (backward-compatible)", async () => {
    global.fetch = jest.fn(async () => ({ ok: true, status: 200 }));

    const { postWebhook } = await import("../src/webhook-delivery.js");

    await postWebhook("https://example.com/hook", { event: "test" }, { secret: null });

    const [, init] = global.fetch.mock.calls[0];
    expect(init.headers["X-Webhook-Signature"]).toBeUndefined();
  });
});

describe("deliverDistributeWebhooks signs with per-webhook secret (#1141)", () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    listWebhooks.mockReset();
    resetWebhookRetryCount.mockReset();
    jest.resetModules();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test("attaches X-Webhook-Signature when webhook has a stored secret", async () => {
    const secret = "stored-webhook-secret";
    listWebhooks.mockReturnValue([
      {
        id: 1,
        url: "https://example.com/hook",
        contractId: "CAAA",
        enabled: 1,
        retry_count: 0,
        next_retry_time: null,
        secret,
      },
    ]);

    global.fetch = jest.fn(async () => ({ ok: true, status: 200 }));

    const { deliverDistributeWebhooks, computeWebhookSignature } = await import(
      "../src/webhook-delivery.js"
    );

    deliverDistributeWebhooks({
      txHash: "a".repeat(64),
      contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      tokenId: "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      requestedAmount: "500",
      status: "confirmed",
      blockTime: "2026-06-01T10:00:00.000Z",
      timestamp: "2026-06-01T10:00:00.000Z",
      payouts: [],
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [, init] = global.fetch.mock.calls[0];

    const expectedSig = computeWebhookSignature(init.body, secret);
    expect(init.headers["X-Webhook-Signature"]).toBe(expectedSig);
  });

  test("delivers without X-Webhook-Signature when webhook secret is null", async () => {
    listWebhooks.mockReturnValue([
      {
        id: 2,
        url: "https://example.com/hook",
        contractId: "CAAA",
        enabled: 1,
        retry_count: 0,
        next_retry_time: null,
        secret: null,
      },
    ]);

    global.fetch = jest.fn(async () => ({ ok: true, status: 200 }));

    const { deliverDistributeWebhooks } = await import("../src/webhook-delivery.js");

    deliverDistributeWebhooks({
      txHash: "b".repeat(64),
      contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      tokenId: "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      requestedAmount: "250",
      status: "confirmed",
      blockTime: "2026-06-01T11:00:00.000Z",
      timestamp: "2026-06-01T11:00:00.000Z",
      payouts: [],
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [, init] = global.fetch.mock.calls[0];
    expect(init.headers["X-Webhook-Signature"]).toBeUndefined();
  });
});
