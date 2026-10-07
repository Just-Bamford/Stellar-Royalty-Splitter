/**
 * Tests for the OpenSea marketplace sync service — closes #928.
 *
 * Covers: payload parsing (a realistic sample OpenSea "item_sold" payload),
 * royalty calculation (default 5% and a configured override), the full
 * simulated pipeline (parse -> calculate -> record via the contract
 * integration point (mocked) -> broadcast via WebSocket (mocked)),
 * idempotency (same event id delivered twice only recorded once), and
 * retry-with-backoff on a simulated contract-call failure using fake timers.
 */
import { jest, describe, test, expect, beforeEach, afterEach } from "@jest/globals";

const mockRecordSecondarySale = jest.fn();
const mockAddAuditLog = jest.fn();

await jest.unstable_mockModule("../src/database/index.js", () => ({
  recordSecondarySale: mockRecordSecondarySale,
  addAuditLog: mockAddAuditLog,
}));

const mockGetMarketplaceEvent = jest.fn();
const mockRecordMarketplaceEvent = jest.fn();
const mockGetMarketplaceSettings = jest.fn(() => ({ contractId: "C", autoRecordingEnabled: true }));

await jest.unstable_mockModule("../src/database/marketplace-events.js", () => ({
  getMarketplaceEvent: mockGetMarketplaceEvent,
  recordMarketplaceEvent: mockRecordMarketplaceEvent,
  getMarketplaceSettings: mockGetMarketplaceSettings,
}));

const mockBuildTx = jest.fn();
const mockI128ToScVal = jest.fn((n) => ({ scval: n.toString() }));

await jest.unstable_mockModule("../src/stellar.js", () => ({
  buildTx: mockBuildTx,
  i128ToScVal: mockI128ToScVal,
}));

const mockBroadcastToContract = jest.fn();

await jest.unstable_mockModule("../src/websocket.js", () => ({
  broadcastToContract: mockBroadcastToContract,
}));

const {
  parseOpenSeaPayload,
  calculateRoyalty,
  retryWithBackoff,
  processOpenSeaSale,
  DEFAULT_ROYALTY_RATE_BPS,
  EXTERNAL_SALE_TOKEN_MARKER,
} = await import("../src/services/opensea-sync.js");

const CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

// A realistic sample OpenSea "item_sold" webhook payload.
const SAMPLE_OPENSEA_PAYLOAD = {
  event_type: "item_sold",
  payload: {
    event_id: "3f9c1a2e-4b5d-4e6f-8a9b-0c1d2e3f4a5b",
    item: {
      nft_id: "ethereum/0xabc1230000000000000000000000000000dead/1337",
      permalink: "https://opensea.io/assets/ethereum/0xabc123/1337",
    },
    collection: { slug: "my-royalty-collection" },
    payment_token: { symbol: "WETH", decimals: 18 },
    sale_price: "2500000000000000000", // 2.5 WETH in wei — exceeds Number.MAX_SAFE_INTEGER-safe precision when combined with fees
    from_account: { address: "0xSellerAddress0000000000000000000000001" },
    to_account: { address: "0xBuyerAddress00000000000000000000000002" },
    maker: "0xSellerAddress0000000000000000000000001",
    taker: "0xBuyerAddress00000000000000000000000002",
    closing_date: "2026-09-24T10:00:00.000000",
  },
};

describe("parseOpenSeaPayload (#928)", () => {
  test("extracts sale price, nft id, seller, and buyer from a realistic payload", () => {
    const parsed = parseOpenSeaPayload(SAMPLE_OPENSEA_PAYLOAD);

    expect(parsed).toEqual({
      eventId: "3f9c1a2e-4b5d-4e6f-8a9b-0c1d2e3f4a5b",
      nftId: "ethereum/0xabc1230000000000000000000000000000dead/1337",
      salePrice: "2500000000000000000",
      seller: "0xSellerAddress0000000000000000000000001",
      buyer: "0xBuyerAddress00000000000000000000000002",
    });
  });

  test("falls back to from_account/to_account when maker/taker are absent", () => {
    const payload = {
      payload: {
        event_id: "evt-2",
        item: { nft_id: "eth/0xabc/2" },
        sale_price: "1000",
        from_account: { address: "0xSeller" },
        to_account: { address: "0xBuyer" },
      },
    };
    const parsed = parseOpenSeaPayload(payload);
    expect(parsed.seller).toBe("0xSeller");
    expect(parsed.buyer).toBe("0xBuyer");
  });

  test("returns null when a required field is missing", () => {
    expect(parseOpenSeaPayload({ payload: { item: { nft_id: "x" } } })).toBeNull();
    expect(parseOpenSeaPayload({})).toBeNull();
    expect(parseOpenSeaPayload(null)).toBeNull();
  });
});

describe("calculateRoyalty (#928)", () => {
  test("calculates at the default 5% (500 bps) rate", () => {
    expect(calculateRoyalty("2500000000000000000")).toBe(125000000000000000n);
    expect(DEFAULT_ROYALTY_RATE_BPS).toBe(500);
  });

  test("calculates at a configured override rate", () => {
    expect(calculateRoyalty("1000000", 250)).toBe(25000n); // 2.5%
    expect(calculateRoyalty("1000000", 1000)).toBe(100000n); // 10%
  });

  test("floors fractional results (matches the manual secondary-royalty route)", () => {
    expect(calculateRoyalty("999", 500)).toBe(49n); // 999 * 500 / 10000 = 49.95 -> 49
  });

  test("handles a large wei-denominated price without precision loss", () => {
    // This value exceeds Number.MAX_SAFE_INTEGER; BigInt math must be exact.
    const salePrice = "123456789012345678901234567890";
    const result = calculateRoyalty(salePrice, 500);
    expect(result).toBe((BigInt(salePrice) * 500n) / 10000n);
  });
});

describe("retryWithBackoff (#928)", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test("returns the result immediately on first success, no delay", async () => {
    const fn = jest.fn().mockResolvedValue("ok");
    const result = await retryWithBackoff(fn, { maxRetries: 3, baseBackoffMs: 1000 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("retries with exponential backoff and eventually succeeds", async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new Error("transient 1"))
      .mockRejectedValueOnce(new Error("transient 2"))
      .mockResolvedValueOnce("recovered");
    const onRetry = jest.fn();

    const promise = retryWithBackoff(fn, { maxRetries: 3, baseBackoffMs: 1000, onRetry });

    // 1st retry after 1000ms, 2nd retry after 2000ms — advance past both
    // without waiting out real time.
    await jest.advanceTimersByTimeAsync(1000);
    await jest.advanceTimersByTimeAsync(2000);

    await expect(promise).resolves.toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenNthCalledWith(1, 1, expect.any(Error));
    expect(onRetry).toHaveBeenNthCalledWith(2, 2, expect.any(Error));
  });

  test("throws the last error once maxRetries is exhausted", async () => {
    const fn = jest.fn().mockRejectedValue(new Error("permanent failure"));

    const promise = retryWithBackoff(fn, { maxRetries: 2, baseBackoffMs: 100 });
    // Swallow the eventual rejection so it isn't reported as unhandled
    // while timers are still being advanced.
    promise.catch(() => {});

    await jest.advanceTimersByTimeAsync(100);
    await jest.advanceTimersByTimeAsync(200);

    await expect(promise).rejects.toThrow("permanent failure");
    expect(fn).toHaveBeenCalledTimes(3); // initial attempt + 2 retries
  });
});

describe("processOpenSeaSale — full pipeline (#928)", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    mockGetMarketplaceEvent.mockReturnValue(null);
    mockGetMarketplaceSettings.mockReturnValue({ contractId: CONTRACT_ID, autoRecordingEnabled: true });
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  const parsed = () => parseOpenSeaPayload(SAMPLE_OPENSEA_PAYLOAD);

  test("records the sale, logs an audit entry, and broadcasts — no relayer wallet configured", async () => {
    delete process.env.OPENSEA_RELAYER_WALLET;

    const result = await processOpenSeaSale({ contractId: CONTRACT_ID, parsed: parsed() });

    expect(result.status).toBe("recorded");
    expect(result.xdr).toBeNull();

    expect(mockRecordSecondarySale).toHaveBeenCalledWith(
      CONTRACT_ID,
      "ethereum/0xabc1230000000000000000000000000000dead/1337",
      "0xSellerAddress0000000000000000000000001",
      "0xBuyerAddress00000000000000000000000002",
      2500000000000000000n,
      EXTERNAL_SALE_TOKEN_MARKER,
      125000000000000000n,
      500
    );

    expect(mockBuildTx).not.toHaveBeenCalled();

    expect(mockRecordMarketplaceEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "opensea",
        eventId: "3f9c1a2e-4b5d-4e6f-8a9b-0c1d2e3f4a5b",
        contractId: CONTRACT_ID,
        status: "skipped_no_relayer",
      })
    );

    expect(mockAddAuditLog).toHaveBeenCalledWith(
      CONTRACT_ID,
      "secondary_sale_recorded",
      "opensea_webhook",
      expect.objectContaining({ eventId: "3f9c1a2e-4b5d-4e6f-8a9b-0c1d2e3f4a5b", source: "opensea" })
    );

    expect(mockBroadcastToContract).toHaveBeenCalledWith(
      CONTRACT_ID,
      expect.objectContaining({
        type: "secondary_sale_recorded",
        source: "opensea",
        royaltyStatus: "pending",
      })
    );
  });

  test("builds the record_secondary_royalty XDR when a relayer wallet is configured", async () => {
    process.env.OPENSEA_RELAYER_WALLET = "GRELAYERWALLET00000000000000000000000000000000000000";
    mockBuildTx.mockResolvedValue("UNSIGNED_XDR_BASE64");

    const result = await processOpenSeaSale({ contractId: CONTRACT_ID, parsed: parsed() });

    expect(result.xdr).toBe("UNSIGNED_XDR_BASE64");
    expect(mockBuildTx).toHaveBeenCalledWith(
      "GRELAYERWALLET00000000000000000000000000000000000000",
      CONTRACT_ID,
      "record_secondary_royalty",
      [expect.anything()]
    );
    expect(mockRecordMarketplaceEvent).toHaveBeenCalledWith(
      expect.objectContaining({ status: "recorded" })
    );
  });

  test("uses a configured royalty rate override", async () => {
    delete process.env.OPENSEA_RELAYER_WALLET;

    const result = await processOpenSeaSale({ contractId: CONTRACT_ID, parsed: parsed(), rateBps: 1000 });

    expect(result.royaltyAmount).toBe((2500000000000000000n * 1000n / 10000n).toString());
  });

  test("idempotency: the same event id is only ever recorded once", async () => {
    mockGetMarketplaceEvent.mockReturnValueOnce(null);
    const first = await processOpenSeaSale({ contractId: CONTRACT_ID, parsed: parsed() });
    expect(first.status).toBe("recorded");
    expect(mockRecordSecondarySale).toHaveBeenCalledTimes(1);
    expect(mockRecordMarketplaceEvent).toHaveBeenCalledTimes(1);

    // Second delivery of the same event: getMarketplaceEvent now reports it exists.
    mockGetMarketplaceEvent.mockReturnValueOnce({
      eventId: "3f9c1a2e-4b5d-4e6f-8a9b-0c1d2e3f4a5b",
      royaltyAmount: "125000000000000000",
    });
    const second = await processOpenSeaSale({ contractId: CONTRACT_ID, parsed: parsed() });

    expect(second.status).toBe("duplicate");
    // No additional writes on the duplicate delivery.
    expect(mockRecordSecondarySale).toHaveBeenCalledTimes(1);
    expect(mockRecordMarketplaceEvent).toHaveBeenCalledTimes(1);
    expect(mockBroadcastToContract).toHaveBeenCalledTimes(1);
  });

  test("skips processing when auto-recording is disabled for the contract", async () => {
    mockGetMarketplaceSettings.mockReturnValue({ contractId: CONTRACT_ID, autoRecordingEnabled: false });

    const result = await processOpenSeaSale({ contractId: CONTRACT_ID, parsed: parsed() });

    expect(result.status).toBe("auto_recording_disabled");
    expect(mockRecordSecondarySale).not.toHaveBeenCalled();
    expect(mockRecordMarketplaceEvent).not.toHaveBeenCalled();
    expect(mockBroadcastToContract).not.toHaveBeenCalled();
  });

  test("retries the XDR build on transient failure and eventually records it as recorded", async () => {
    jest.useFakeTimers();
    process.env.OPENSEA_RELAYER_WALLET = "GRELAYERWALLET00000000000000000000000000000000000000";
    mockBuildTx
      .mockRejectedValueOnce(new Error("RPC timeout"))
      .mockResolvedValueOnce("UNSIGNED_XDR_AFTER_RETRY");

    const promise = processOpenSeaSale({ contractId: CONTRACT_ID, parsed: parsed() });
    await jest.advanceTimersByTimeAsync(1000);

    const result = await promise;

    expect(result.xdr).toBe("UNSIGNED_XDR_AFTER_RETRY");
    expect(mockBuildTx).toHaveBeenCalledTimes(2);
    expect(mockRecordMarketplaceEvent).toHaveBeenCalledWith(
      expect.objectContaining({ status: "recorded" })
    );

    jest.useRealTimers();
  });

  test("still records the sale and broadcasts even when the contract-call step fails after all retries", async () => {
    jest.useFakeTimers();
    process.env.OPENSEA_RELAYER_WALLET = "GRELAYERWALLET00000000000000000000000000000000000000";
    mockBuildTx.mockRejectedValue(new Error("RPC permanently down"));

    const promise = processOpenSeaSale({ contractId: CONTRACT_ID, parsed: parsed() });

    // Module defaults are 3 retries with 1000ms base backoff doubling each
    // attempt (1s, 2s, 4s) — advance past all of them without waiting out
    // real time.
    await jest.advanceTimersByTimeAsync(1000);
    await jest.advanceTimersByTimeAsync(2000);
    await jest.advanceTimersByTimeAsync(4000);

    const result = await promise;

    expect(result.status).toBe("recorded"); // sale itself is still durably recorded
    expect(result.xdr).toBeNull();
    expect(mockRecordSecondarySale).toHaveBeenCalledTimes(1);
    expect(mockBuildTx).toHaveBeenCalledTimes(4); // initial attempt + 3 retries
    expect(mockRecordMarketplaceEvent).toHaveBeenCalledWith(
      expect.objectContaining({ status: "contract_call_failed" })
    );
    expect(mockBroadcastToContract).toHaveBeenCalledTimes(1);

    jest.useRealTimers();
  }, 15_000);
});
