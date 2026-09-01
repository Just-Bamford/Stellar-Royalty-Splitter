import { jest, describe, test, expect, beforeEach } from "@jest/globals";

// ── Mocks ────────────────────────────────────────────────────────────────────

const listWebhooks = jest.fn();
const updateWebhookRetryStateWithPayload = jest.fn();
const resetWebhookRetryCount = jest.fn();
const moveToDlq = jest.fn();
const loggerInfo = jest.fn();
const loggerWarn = jest.fn();
const loggerError = jest.fn();

await jest.unstable_mockModule("../src/database/webhooks.js", () => ({
  listWebhooks,
  updateWebhookRetryStateWithPayload,
  resetWebhookRetryCount,
  moveToDlq,
}));

await jest.unstable_mockModule("../src/logger.js", () => ({
  default: {
    info: loggerInfo,
    warn: loggerWarn,
    error: loggerError,
  },
}));

const { deliverDistributeWebhooks, postWebhook, _config } = await import("../src/webhook-delivery.js");

// ── Helpers ───────────────────────────────────────────────────────────────────

const BASE_TRANSACTION = {
  contractId: "CABC123",
  txHash: "tx_hash_abc",
  tokenId: "token1",
  requestedAmount: "1000",
  status: "confirmed",
  payouts: [
    { collaboratorAddress: "addr1", amountReceived: "500" },
    { collaboratorAddress: "addr2", amountReceived: "500" },
  ],
  blockTime: "2026-08-26T12:00:00Z",
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Webhook DLQ (#818)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("moveToDlq is called after retries are exhausted", async () => {
    const webhook = {
      id: 42,
      contractId: "CABC123",
      url: "https://example.com/hook",
      retry_count: 3,
    };
    listWebhooks.mockReturnValue([webhook]);

    // Make postWebhook fail
    const originalFetch = globalThis.fetch;
    globalThis.fetch = jest.fn().mockRejectedValue(new Error("network timeout"));

    deliverDistributeWebhooks(BASE_TRANSACTION);

    // Allow async promise chain to settle
    await new Promise((r) => setTimeout(r, 50));

    expect(moveToDlq).toHaveBeenCalledTimes(1);
    expect(moveToDlq).toHaveBeenCalledWith(
      42,
      "https://example.com/hook",
      "CABC123",
      expect.any(String),
      "network timeout",
      4
    );

    globalThis.fetch = originalFetch;
  });

  test("moveToDlq is NOT called when retries are below max", async () => {
    const webhook = {
      id: 10,
      contractId: "CABC123",
      url: "https://example.com/hook",
      retry_count: 1,
    };
    listWebhooks.mockReturnValue([webhook]);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = jest.fn().mockRejectedValue(new Error("connection refused"));

    deliverDistributeWebhooks(BASE_TRANSACTION);

    await new Promise((r) => setTimeout(r, 50));

    expect(moveToDlq).not.toHaveBeenCalled();
    expect(loggerError).not.toHaveBeenCalledWith(
      expect.stringContaining("DLQ"),
      expect.anything()
    );

    globalThis.fetch = originalFetch;
  });

  test("moveToDlq failure is caught and logged without crashing", async () => {
    const webhook = {
      id: 99,
      contractId: "CABC123",
      url: "https://example.com/hook",
      retry_count: 3,
    };
    listWebhooks.mockReturnValue([webhook]);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = jest.fn().mockRejectedValue(new Error("server error"));

    // Make the DLQ insert itself fail
    moveToDlq.mockImplementation(() => {
      throw new Error("DLQ write failed");
    });

    // Should not throw
    deliverDistributeWebhooks(BASE_TRANSACTION);

    await new Promise((r) => setTimeout(r, 50));

    expect(loggerError).toHaveBeenCalledWith(
      "Failed to move webhook to DLQ",
      expect.objectContaining({
        webhookId: 99,
        error: "DLQ write failed",
      })
    );

    globalThis.fetch = originalFetch;
  });
});
