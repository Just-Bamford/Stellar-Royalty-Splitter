import { jest, describe, test, expect, beforeEach, afterEach } from "@jest/globals";

const listWebhooks = jest.fn();

await jest.unstable_mockModule("../src/database/webhooks.js", () => ({
  listWebhooks,
  enqueueDeadLetter: jest.fn(),
  listAllPendingDeadLetters: jest.fn(() => []),
  markDeadLetterRetried: jest.fn(),
  deleteOldDeadLetters: jest.fn(() => 0),
  registerWebhook: jest.fn(),
  listDeadLetters: jest.fn(),
  deleteWebhook: jest.fn(),
}));

describe("deliverDistributeWebhooks (#295)", () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    listWebhooks.mockReset();
    jest.resetModules();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test("POSTs payload to registered webhooks with retry on failure", async () => {
    listWebhooks.mockReturnValue([
      { id: 1, url: "https://example.com/hook", contractId: "CAAA", enabled: 1 },
    ]);

    let attempts = 0;
    global.fetch = jest.fn(async () => {
      attempts += 1;
      if (attempts === 1) {
        return { ok: false, status: 500 };
      }
      return { ok: true, status: 200 };
    });

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

    await new Promise((resolve) => setTimeout(resolve, 1200));

    expect(global.fetch.mock.calls.length).toBeGreaterThanOrEqual(2);
    const [, init] = global.fetch.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({
      event: "distribute.confirmed",
      status: "confirmed",
      recipients: [{ address: "GAAA", amount: "500" }],
    });
  });
});
