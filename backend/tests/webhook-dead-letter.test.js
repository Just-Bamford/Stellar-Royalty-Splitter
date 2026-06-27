import { jest, describe, test, expect, beforeEach, afterEach } from "@jest/globals";

const enqueueDeadLetter = jest.fn();
const listAllPendingDeadLetters = jest.fn();
const markDeadLetterRetried = jest.fn();
const listWebhooks = jest.fn();

await jest.unstable_mockModule("../src/database/webhooks.js", () => ({
  listWebhooks,
  enqueueDeadLetter,
  listAllPendingDeadLetters,
  markDeadLetterRetried,
  registerWebhook: jest.fn(),
  listDeadLetters: jest.fn(),
  deleteWebhook: jest.fn(),
  deleteOldDeadLetters: jest.fn(() => 0),
}));

const CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const WEBHOOK_URL = "https://example.com/hook";

const sampleTransaction = {
  txHash: "a".repeat(64),
  contractId: CONTRACT,
  tokenId: "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
  requestedAmount: "1000",
  status: "confirmed",
  blockTime: "2026-06-24T00:00:00.000Z",
  timestamp: "2026-06-24T00:00:00.000Z",
  payouts: [{ collaboratorAddress: "GAAA", amountReceived: "500" }],
};

describe("Webhook dead-letter queue (#401)", () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    listWebhooks.mockReset();
    enqueueDeadLetter.mockReset();
    listAllPendingDeadLetters.mockReset();
    markDeadLetterRetried.mockReset();
    jest.resetModules();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test("failed webhook after exhausted retries is written to dead-letter queue", async () => {
    listWebhooks.mockReturnValue([{ id: 1, url: WEBHOOK_URL, contractId: CONTRACT, enabled: 1 }]);
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 503 });

    const { deliverDistributeWebhooks } = await import("../src/webhook-delivery.js");
    deliverDistributeWebhooks(sampleTransaction);

    // Wait for all retries + dead-letter write
    await new Promise((resolve) => setTimeout(resolve, 4000));

    expect(enqueueDeadLetter).toHaveBeenCalledWith(
      1,
      CONTRACT,
      WEBHOOK_URL,
      expect.objectContaining({ event: "distribute.confirmed" }),
      expect.any(String),
    );
  }, 10_000);

  test("successful webhook delivery does NOT write to dead-letter queue", async () => {
    listWebhooks.mockReturnValue([{ id: 2, url: WEBHOOK_URL, contractId: CONTRACT, enabled: 1 }]);
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });

    const { deliverDistributeWebhooks } = await import("../src/webhook-delivery.js");
    deliverDistributeWebhooks(sampleTransaction);

    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(enqueueDeadLetter).not.toHaveBeenCalled();
  });

  test("retry scheduler processes dead-letter entries and calls markDeadLetterRetried on success", async () => {
    const entry = {
      id: 10,
      webhookId: 1,
      contractId: CONTRACT,
      url: WEBHOOK_URL,
      payload: JSON.stringify({ event: "distribute.confirmed" }),
      errorMessage: "timeout",
      retryCount: 1,
    };
    listAllPendingDeadLetters.mockReturnValue([entry]);
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });

    // Set env var BEFORE importing so the constant is evaluated with the right value
    process.env.WEBHOOK_RETRY_SCHEDULER_MS = "50";
    const { startWebhookRetryScheduler } = await import("../src/webhook-delivery.js");
    const handle = startWebhookRetryScheduler();

    await new Promise((resolve) => setTimeout(resolve, 300));
    clearInterval(handle);
    delete process.env.WEBHOOK_RETRY_SCHEDULER_MS;

    expect(markDeadLetterRetried).toHaveBeenCalledWith(10, true);
  }, 5_000);

  test("retry scheduler marks entry as failed when delivery still fails", async () => {
    const entry = {
      id: 11,
      webhookId: 1,
      contractId: CONTRACT,
      url: WEBHOOK_URL,
      payload: JSON.stringify({ event: "distribute.confirmed" }),
      errorMessage: "timeout",
      retryCount: 2,
    };
    listAllPendingDeadLetters.mockReturnValue([entry]);
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 });

    process.env.WEBHOOK_RETRY_SCHEDULER_MS = "50";
    process.env.WEBHOOK_RETRY_BASE_MS = "10"; // fast backoff so 3 retries complete quickly
    const { startWebhookRetryScheduler } = await import("../src/webhook-delivery.js");
    const handle = startWebhookRetryScheduler();

    await new Promise((resolve) => setTimeout(resolve, 600));
    clearInterval(handle);
    delete process.env.WEBHOOK_RETRY_SCHEDULER_MS;
    delete process.env.WEBHOOK_RETRY_BASE_MS;

    expect(markDeadLetterRetried).toHaveBeenCalledWith(11, false);
  }, 5_000);
});
