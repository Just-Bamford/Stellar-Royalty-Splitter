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

    await deliverDistributeWebhooks({
      txHash: "d".repeat(64),
      contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      tokenId: "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      requestedAmount: "1000",
      status: "confirmed",
      blockTime: "2026-05-31T12:00:00.000Z",
      timestamp: "2026-05-31T12:00:00.000Z",
      payouts: [{ collaboratorAddress: "GAAA", amountReceived: "500" }],
    });

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

    await deliverDistributeWebhooks({
      txHash: "d".repeat(64),
      contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      tokenId: "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      requestedAmount: "1000",
      status: "confirmed",
      blockTime: "2026-05-31T12:00:00.000Z",
      timestamp: "2026-05-31T12:00:00.000Z",
      payouts: [{ collaboratorAddress: "GAAA", amountReceived: "500" }],
    });

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

    await deliverDistributeWebhooks({
      txHash: "d".repeat(64),
      contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      tokenId: "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      requestedAmount: "1000",
      status: "confirmed",
      blockTime: "2026-05-31T12:00:00.000Z",
      timestamp: "2026-05-31T12:00:00.000Z",
      payouts: [{ collaboratorAddress: "GAAA", amountReceived: "500" }],
    });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(resetWebhookRetryCount).toHaveBeenCalledTimes(1);
  });
});
