/**
 * Tests for the Rarible resale sync service — closes #954.
 *
 * Covers multi-chain (Ethereum + Polygon) payload parsing, chain-qualified
 * identifier splitting, unsupported-chain rejection, royalty calculation,
 * the external-sale marker, and `processRaribleSale`'s idempotency,
 * auto-recording toggle, contract-call retry/failover and audit/broadcast
 * side effects.
 */
import { jest, describe, test, expect, beforeEach, afterEach } from "@jest/globals";

const mockGetMarketplaceEvent = jest.fn(() => null);
const mockRecordMarketplaceEvent = jest.fn();
const mockGetMarketplaceSettings = jest.fn(() => ({ autoRecordingEnabled: true }));

await jest.unstable_mockModule("../src/database/marketplace-events.js", () => ({
  getMarketplaceEvent: mockGetMarketplaceEvent,
  recordMarketplaceEvent: mockRecordMarketplaceEvent,
  getMarketplaceSettings: mockGetMarketplaceSettings,
}));

const mockRecordSecondarySale = jest.fn(() => 1);
const mockAddAuditLog = jest.fn();

await jest.unstable_mockModule("../src/database/index.js", () => ({
  recordSecondarySale: mockRecordSecondarySale,
  addAuditLog: mockAddAuditLog,
}));

const mockBuildTx = jest.fn();

await jest.unstable_mockModule("../src/stellar.js", () => ({
  buildTx: mockBuildTx,
  i128ToScVal: (n) => ({ scval: n.toString() }),
}));

const mockBroadcastToContract = jest.fn();

await jest.unstable_mockModule("../src/websocket.js", () => ({
  broadcastToContract: mockBroadcastToContract,
}));

// Keep the retry loop fast in the failure-path tests below.
process.env.RARIBLE_SYNC_MAX_RETRIES = "2";
process.env.RARIBLE_SYNC_BACKOFF_MS = "1";

const {
  parseRariblePayload,
  splitChainQualified,
  raribleSaleTokenMarker,
  calculateRoyalty,
  processRaribleSale,
  RARIBLE_PROVIDER,
  SUPPORTED_RARIBLE_CHAINS,
} = await import("../src/services/rarible-sync.js");

const CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const ETHEREUM_EVENT = {
  id: "ETHEREUM:0xabc:1",
  blockchain: "ETHEREUM",
  contract: "ETHEREUM:0xabc",
  tokenId: "1",
  seller: "0xSeller",
  buyer: "0xBuyer",
  price: "1000000000000000000",
};

const POLYGON_EVENT = {
  id: "POLYGON:0xdef:2",
  blockchain: "POLYGON",
  contract: "POLYGON:0xdef",
  tokenId: "2",
  seller: "0xSeller",
  buyer: "0xBuyer",
  price: "500000000000000000",
};

describe("splitChainQualified", () => {
  test("splits a chain-qualified identifier", () => {
    expect(splitChainQualified("ETHEREUM:0xabc")).toEqual({ chain: "ethereum", address: "0xabc" });
    expect(splitChainQualified("POLYGON:0xdef")).toEqual({ chain: "polygon", address: "0xdef" });
  });

  test("leaves an unqualified address intact", () => {
    expect(splitChainQualified("0xabc")).toEqual({ chain: null, address: "0xabc" });
  });

  test("returns nulls for empty input", () => {
    expect(splitChainQualified(null)).toEqual({ chain: null, address: null });
    expect(splitChainQualified("   ")).toEqual({ chain: null, address: null });
  });
});

describe("parseRariblePayload", () => {
  test("parses a bare Ethereum activity object", () => {
    expect(parseRariblePayload(ETHEREUM_EVENT)).toEqual({
      eventId: "ETHEREUM:0xabc:1",
      nftId: "ethereum/0xabc/1",
      salePrice: "1000000000000000000",
      seller: "0xSeller",
      buyer: "0xBuyer",
      chain: "ethereum",
    });
  });

  test("parses a Polygon activity object", () => {
    const parsed = parseRariblePayload(POLYGON_EVENT);

    expect(parsed.chain).toBe("polygon");
    expect(parsed.nftId).toBe("polygon/0xdef/2");
  });

  test("parses a data-enveloped payload", () => {
    const parsed = parseRariblePayload({ event: "ORDER_SALE", data: ETHEREUM_EVENT });

    expect(parsed.eventId).toBe("ETHEREUM:0xabc:1");
    expect(parsed.chain).toBe("ethereum");
  });

  test("falls back to the envelope's event id", () => {
    const { id, ...withoutId } = ETHEREUM_EVENT;
    const parsed = parseRariblePayload({ event_id: "envelope-id", data: withoutId });

    expect(parsed.eventId).toBe("envelope-id");
  });

  test("derives an event id from the transaction hash and token id", () => {
    const { id, ...withoutId } = ETHEREUM_EVENT;
    const parsed = parseRariblePayload({ ...withoutId, transactionHash: "0xdeadbeef" });

    expect(parsed.eventId).toBe("0xdeadbeef:1");
  });

  test("prefers an explicit nftId when provided", () => {
    const parsed = parseRariblePayload({ ...ETHEREUM_EVENT, nftId: "custom-nft-id" });

    expect(parsed.nftId).toBe("custom-nft-id");
  });

  test("resolves the chain from the contract when blockchain is absent", () => {
    const { blockchain, ...withoutChain } = ETHEREUM_EVENT;
    const parsed = parseRariblePayload(withoutChain);

    expect(parsed.chain).toBe("ethereum");
  });

  test("rejects unsupported chains", () => {
    expect(SUPPORTED_RARIBLE_CHAINS).toEqual(["ethereum", "polygon"]);
    expect(parseRariblePayload({ ...ETHEREUM_EVENT, blockchain: "SOLANA" })).toBeNull();
    expect(parseRariblePayload({ ...ETHEREUM_EVENT, blockchain: "TEZOS" })).toBeNull();
  });

  test("rejects payloads missing required fields", () => {
    const { price, ...noPrice } = ETHEREUM_EVENT;
    expect(parseRariblePayload(noPrice)).toBeNull();

    const { seller, ...noSeller } = ETHEREUM_EVENT;
    expect(parseRariblePayload(noSeller)).toBeNull();

    const { tokenId, contract, ...noNft } = ETHEREUM_EVENT;
    expect(parseRariblePayload(noNft)).toBeNull();
  });

  test("never splits a bare 0x address as a chain qualifier", () => {
    const parsed = parseRariblePayload({
      ...ETHEREUM_EVENT,
      seller: "0xSeller",
      blockchain: "POLYGON",
      contract: "0xdef",
    });

    expect(parsed.seller).toBe("0xSeller");
    expect(parsed.chain).toBe("polygon");
  });
});

describe("raribleSaleTokenMarker", () => {
  test("marks the sale as an external, chain-qualified payment", () => {
    expect(raribleSaleTokenMarker("ethereum")).toBe("RARIBLE_EXTERNAL:ethereum");
    expect(raribleSaleTokenMarker("polygon")).toBe("RARIBLE_EXTERNAL:polygon");
  });
});

describe("calculateRoyalty", () => {
  test("computes 5% (500 bps) by default", () => {
    expect(calculateRoyalty("1000000000000000000")).toBe(50000000000000000n);
  });

  test("honours a custom basis-points rate", () => {
    expect(calculateRoyalty("1000000000000000000", 1000)).toBe(100000000000000000n);
    expect(calculateRoyalty("1000000000000000000", 250)).toBe(25000000000000000n);
  });

  test("floors fractional amounts like routes/secondary-royalty.js", () => {
    expect(calculateRoyalty("999", 500)).toBe(49n);
  });
});

describe("processRaribleSale", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetMarketplaceEvent.mockReturnValue(null);
    mockGetMarketplaceSettings.mockReturnValue({ autoRecordingEnabled: true });
    mockBuildTx.mockResolvedValue("AAAAAG5vbmNl");
    delete process.env.RARIBLE_RELAYER_WALLET;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  function parsed(overrides = {}) {
    return { ...parseRariblePayload(ETHEREUM_EVENT), ...overrides };
  }

  test("records the sale, audit log and websocket broadcast", async () => {
    const result = await processRaribleSale({ contractId: CONTRACT_ID, parsed: parsed() });

    expect(result.status).toBe("recorded");
    expect(result.chain).toBe("ethereum");
    expect(result.royaltyAmount).toBe("50000000000000000");

    expect(mockRecordSecondarySale).toHaveBeenCalledWith(
      CONTRACT_ID,
      "ethereum/0xabc/1",
      "0xSeller",
      "0xBuyer",
      1000000000000000000n,
      "RARIBLE_EXTERNAL:ethereum",
      50000000000000000n,
      500
    );
    expect(mockRecordMarketplaceEvent).toHaveBeenCalledWith(
      expect.objectContaining({ provider: RARIBLE_PROVIDER, eventId: "ETHEREUM:0xabc:1" })
    );
    expect(mockAddAuditLog).toHaveBeenCalledWith(
      CONTRACT_ID,
      "secondary_sale_recorded",
      "rarible_webhook",
      expect.objectContaining({ source: "rarible", chain: "ethereum" })
    );
    expect(mockBroadcastToContract).toHaveBeenCalledWith(
      CONTRACT_ID,
      expect.objectContaining({ type: "secondary_sale_recorded", royaltyStatus: "pending" })
    );
  });

  test("returns the existing record for a duplicate event without re-recording", async () => {
    mockGetMarketplaceEvent.mockReturnValue({ eventId: "ETHEREUM:0xabc:1", royaltyAmount: "123" });

    const result = await processRaribleSale({ contractId: CONTRACT_ID, parsed: parsed() });

    expect(result).toEqual({ status: "duplicate", royaltyAmount: "123" });
    expect(mockRecordSecondarySale).not.toHaveBeenCalled();
    expect(mockBroadcastToContract).not.toHaveBeenCalled();
  });

  test("skips when auto-recording is disabled", async () => {
    mockGetMarketplaceSettings.mockReturnValue({ autoRecordingEnabled: false });

    const result = await processRaribleSale({ contractId: CONTRACT_ID, parsed: parsed() });

    expect(result).toEqual({ status: "auto_recording_disabled" });
    expect(mockRecordSecondarySale).not.toHaveBeenCalled();
  });

  test("applies the provided royalty rate", async () => {
    const result = await processRaribleSale({
      contractId: CONTRACT_ID,
      parsed: parsed(),
      rateBps: 1000,
    });

    expect(result.royaltyAmount).toBe("100000000000000000");
    expect(mockRecordSecondarySale.mock.calls[0][7]).toBe(1000);
  });

  test("swallows a duplicate-key error and still records the marketplace event", async () => {
    const err = new Error("UNIQUE constraint failed");
    err.code = "SQLITE_CONSTRAINT_UNIQUE";
    mockRecordSecondarySale.mockImplementationOnce(() => {
      throw err;
    });

    const result = await processRaribleSale({ contractId: CONTRACT_ID, parsed: parsed() });

    expect(result.status).toBe("recorded");
    expect(mockRecordMarketplaceEvent).toHaveBeenCalledTimes(1);
  });

  test("builds a contract-call XDR when a relayer wallet is configured", async () => {
    process.env.RARIBLE_RELAYER_WALLET = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

    const result = await processRaribleSale({ contractId: CONTRACT_ID, parsed: parsed() });

    expect(mockBuildTx).toHaveBeenCalledTimes(1);
    expect(result.xdr).toBe("AAAAAG5vbmNl");
    expect(mockRecordMarketplaceEvent.mock.calls[0][0].status).toBe("recorded");
  });

  test("records without an XDR when no relayer wallet is configured", async () => {
    const result = await processRaribleSale({ contractId: CONTRACT_ID, parsed: parsed() });

    expect(mockBuildTx).not.toHaveBeenCalled();
    expect(result.xdr).toBeNull();
    expect(mockRecordMarketplaceEvent.mock.calls[0][0].status).toBe("skipped_no_relayer");
  });

  test("retries the contract-call build and fails over on persistent errors", async () => {
    process.env.RARIBLE_RELAYER_WALLET = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
    mockBuildTx.mockRejectedValue(new Error("horizon unavailable"));

    const result = await processRaribleSale({ contractId: CONTRACT_ID, parsed: parsed() });

    // 1 initial attempt + RARIBLE_SYNC_MAX_RETRIES (2) = 3 calls.
    expect(mockBuildTx).toHaveBeenCalledTimes(3);
    expect(result.status).toBe("recorded");
    expect(result.xdr).toBeNull();
    expect(mockRecordMarketplaceEvent.mock.calls[0][0].status).toBe("contract_call_failed");
    // The sale is still persisted and broadcast despite the failure.
    expect(mockRecordSecondarySale).toHaveBeenCalledTimes(1);
    expect(mockBroadcastToContract).toHaveBeenCalledTimes(1);
  });
});
