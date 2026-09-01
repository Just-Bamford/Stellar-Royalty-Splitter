import { jest, describe, test, expect, beforeEach, afterEach } from "@jest/globals";

const mockGetWebhooksDueForRetry = jest.fn();
const mockUpdateWebhookRetryStateWithPayload = jest.fn();
const mockResetWebhookRetryCount = jest.fn();

await jest.unstable_mockModule("../src/database/webhooks.js", () => ({
  getWebhooksDueForRetry: mockGetWebhooksDueForRetry,
  updateWebhookRetryStateWithPayload: mockUpdateWebhookRetryStateWithPayload,
  resetWebhookRetryCount: mockResetWebhookRetryCount,
}));

await jest.unstable_mockModule("../src/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const { executeWebhookRetryRun } = await import("../src/jobs/retry-failed-webhooks.js");
const { _config } = await import("../src/webhook-delivery.js");

describe("executeWebhookRetryRun (#743)", () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    mockGetWebhooksDueForRetry.mockReset();
    mockUpdateWebhookRetryStateWithPayload.mockReset();
    mockResetWebhookRetryCount.mockReset();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test("returns zero counts when no webhooks are due for retry", async () => {
    mockGetWebhooksDueForRetry.mockReturnValue([]);

    const result = await executeWebhookRetryRun();

    expect(result).toEqual({ attempted: 0, succeeded: 0, failed: 0, exhausted: 0 });
    expect(global.fetch).toBeUndefined();
  });

  test("retries a due webhook and resets state on success", async () => {
    const payload = { event: "distribute.confirmed", transactionHash: "a".repeat(64) };
    mockGetWebhooksDueForRetry.mockReturnValue([
      {
        id: 5,
        contractId: "CAAA",
        url: "https://example.com/hook",
        retry_count: 1,
        next_retry_time: "2026-01-01T00:00:00.000Z",
        payload: JSON.stringify(payload),
      },
    ]);

    global.fetch = jest.fn(async () => ({ ok: true, status: 200 }));

    const result = await executeWebhookRetryRun(new Date("2026-01-01T00:05:00.000Z"));

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe("https://example.com/hook");
    expect(JSON.parse(init.body)).toEqual(payload);

    expect(mockResetWebhookRetryCount).toHaveBeenCalledWith(5);
    expect(mockUpdateWebhookRetryStateWithPayload).not.toHaveBeenCalled();
    expect(result).toEqual({ attempted: 1, succeeded: 1, failed: 0, exhausted: 0 });
  });

  test("reschedules with the next backoff step when a retry attempt fails", async () => {
    const payload = { event: "distribute.confirmed" };
    mockGetWebhooksDueForRetry.mockReturnValue([
      {
        id: 7,
        contractId: "CBBB",
        url: "https://example.com/flaky",
        retry_count: 1,
        next_retry_time: "2026-01-01T00:00:00.000Z",
        payload: JSON.stringify(payload),
      },
    ]);

    global.fetch = jest.fn(async () => ({ ok: false, status: 503 }));

    const now = new Date("2026-01-01T00:05:00.000Z");
    const result = await executeWebhookRetryRun(now);

    expect(mockResetWebhookRetryCount).not.toHaveBeenCalled();
    expect(mockUpdateWebhookRetryStateWithPayload).toHaveBeenCalledTimes(1);

    const [webhookId, retryCount, nextRetryTimeIso, storedPayload] =
      mockUpdateWebhookRetryStateWithPayload.mock.calls[0];
    expect(webhookId).toBe(7);
    expect(retryCount).toBe(2);
    // Second backoff step (index 1) per _config.BACKOFF_MS.
    expect(new Date(nextRetryTimeIso).getTime()).toBe(now.getTime() + _config.BACKOFF_MS[1]);
    expect(storedPayload).toBe(JSON.stringify(payload));

    expect(result).toEqual({ attempted: 1, succeeded: 0, failed: 1, exhausted: 0 });
  });

  test("marks a webhook permanently failed once max retries is reached", async () => {
    const payload = { event: "distribute.confirmed" };
    mockGetWebhooksDueForRetry.mockReturnValue([
      {
        id: 9,
        contractId: "CCCC",
        url: "https://example.com/dead",
        // Already at MAX_WEBHOOK_RETRIES - 1; this attempt pushes it over the edge.
        retry_count: _config.MAX_WEBHOOK_RETRIES - 1,
        next_retry_time: "2026-01-01T00:00:00.000Z",
        payload: JSON.stringify(payload),
      },
    ]);

    global.fetch = jest.fn(async () => ({ ok: false, status: 500 }));

    const now = new Date("2026-01-01T00:05:00.000Z");
    const result = await executeWebhookRetryRun(now);

    expect(mockUpdateWebhookRetryStateWithPayload).toHaveBeenCalledTimes(1);
    const [webhookId, retryCount, nextRetryTime] = mockUpdateWebhookRetryStateWithPayload.mock.calls[0];
    expect(webhookId).toBe(9);
    expect(retryCount).toBe(_config.MAX_WEBHOOK_RETRIES);
    // No further retry is scheduled once the max is reached.
    expect(nextRetryTime).toBeNull();

    expect(result).toEqual({ attempted: 1, succeeded: 0, failed: 1, exhausted: 1 });
  });

  test("skips a row with unparseable stored payload without throwing", async () => {
    mockGetWebhooksDueForRetry.mockReturnValue([
      {
        id: 11,
        contractId: "CDDD",
        url: "https://example.com/broken",
        retry_count: 1,
        next_retry_time: "2026-01-01T00:00:00.000Z",
        payload: "{not-json",
      },
    ]);

    global.fetch = jest.fn(async () => ({ ok: true, status: 200 }));

    const result = await executeWebhookRetryRun();

    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockResetWebhookRetryCount).not.toHaveBeenCalled();
    expect(mockUpdateWebhookRetryStateWithPayload).not.toHaveBeenCalled();
    expect(result).toEqual({ attempted: 1, succeeded: 0, failed: 0, exhausted: 0 });
  });

  test("processes multiple due webhooks independently in one run", async () => {
    mockGetWebhooksDueForRetry.mockReturnValue([
      {
        id: 1,
        contractId: "C1",
        url: "https://example.com/ok",
        retry_count: 1,
        next_retry_time: "2026-01-01T00:00:00.000Z",
        payload: JSON.stringify({ event: "a" }),
      },
      {
        id: 2,
        contractId: "C2",
        url: "https://example.com/bad",
        retry_count: 1,
        next_retry_time: "2026-01-01T00:00:00.000Z",
        payload: JSON.stringify({ event: "b" }),
      },
    ]);

    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockResolvedValueOnce({ ok: false, status: 500 });

    const result = await executeWebhookRetryRun(new Date("2026-01-01T00:05:00.000Z"));

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(mockResetWebhookRetryCount).toHaveBeenCalledWith(1);
    expect(mockUpdateWebhookRetryStateWithPayload).toHaveBeenCalledWith(
      2,
      2,
      expect.any(String),
      expect.any(String),
    );
    expect(result).toEqual({ attempted: 2, succeeded: 1, failed: 1, exhausted: 0 });
  });
});
