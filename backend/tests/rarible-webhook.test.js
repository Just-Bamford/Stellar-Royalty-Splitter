/**
 * Tests for the Rarible webhook route — closes #954.
 *
 * Covers: signature validation (valid accepted, invalid/missing rejected
 * with 401), missing contract id rejected with 400, unsupported Rarible
 * chains rejected with 400, a full simulated webhook POST asserting the
 * whole pipeline runs (parse -> calculate -> record -> broadcast, all
 * mocked at the integration points), multi-chain Ethereum/Polygon parsing,
 * and the marketplace auto-recording settings endpoints.
 */
import { jest, describe, test, expect, beforeEach, afterEach } from "@jest/globals";
import request from "supertest";
import crypto from "crypto";

const mockGetMarketplaceEvent = jest.fn(() => null);
const mockGetMarketplaceSettings = jest.fn(() => ({ contractId: "C", autoRecordingEnabled: true }));
const mockSaveMarketplaceSettings = jest.fn();

await jest.unstable_mockModule("../src/database/marketplace-events.js", () => ({
  getMarketplaceEvent: mockGetMarketplaceEvent,
  recordMarketplaceEvent: jest.fn(),
  getMarketplaceSettings: mockGetMarketplaceSettings,
  saveMarketplaceSettings: mockSaveMarketplaceSettings,
}));

const mockRecordSecondarySale = jest.fn();
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

// Retry tuning is read once at service-module load, so set it before the
// import below to keep the failure-path test fast (no real backoff sleeps).
process.env.RARIBLE_SYNC_MAX_RETRIES = "2";
process.env.RARIBLE_SYNC_BACKOFF_MS = "1";

const express = (await import("express")).default;
const { raribleRouter } = await import("../src/routes/marketplaces/rarible.js");

const app = express();
app.use("/api/v1/marketplaces/rarible", raribleRouter);

const CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const SECRET = "test-rarible-webhook-secret";

const ETHEREUM_PAYLOAD = {
  event: "ORDER_SALE",
  data: {
    id: "ETHEREUM:0xabcdef1234567890abcdef1234567890abcdef12:1337:1",
    type: "SALE",
    blockchain: "ETHEREUM",
    contract: "ETHEREUM:0xabcdef1234567890abcdef1234567890abcdef12",
    tokenId: "1337",
    seller: "ETHEREUM:0xSellerAddress0000000000000000000000001",
    buyer: "ETHEREUM:0xBuyerAddress00000000000000000000000002",
    price: "2500000000000000000",
    transactionHash: "0xdeadbeef",
  },
};

const POLYGON_PAYLOAD = {
  id: "POLYGON:0x1111111111111111111111111111111111111111:42:1",
  type: "SALE",
  blockchain: "POLYGON",
  contract: "POLYGON:0x1111111111111111111111111111111111111111",
  tokenId: "42",
  seller: "0xPolygonSeller0000000000000000000000000001",
  buyer: "0xPolygonBuyer00000000000000000000000000002",
  price: "1000000000000000000",
};

function sign(body, secret = SECRET) {
  return crypto.createHmac("sha256", secret).update(body).digest("hex");
}

function post(payload, { contractId = CONTRACT_ID, secret = SECRET, signature } = {}) {
  const body = JSON.stringify(payload);
  const req = request(app).post(`/api/v1/marketplaces/rarible/webhooks/${contractId}`);
  req.set("Content-Type", "application/json");
  req.set("X-Rarible-Signature", signature ?? sign(body, secret));
  return req.send(body);
}

describe("POST /api/v1/marketplaces/rarible/webhooks/:contractId — signature validation", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      RARIBLE_WEBHOOK_SECRET: SECRET,
      RARIBLE_RELAYER_WALLET: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    };
    mockGetMarketplaceEvent.mockReturnValue(null);
    mockGetMarketplaceSettings.mockReturnValue({ contractId: CONTRACT_ID, autoRecordingEnabled: true });
    mockBuildTx.mockResolvedValue("AAAAAG5vbmNl");
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test("accepts a request with a valid signature", async () => {
    const res = await post(ETHEREUM_PAYLOAD);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe("recorded");
  });

  test("rejects a request with an invalid signature (401)", async () => {
    const res = await post(ETHEREUM_PAYLOAD, { signature: "deadbeef".repeat(8) });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe("invalid_signature");
    expect(mockBroadcastToContract).not.toHaveBeenCalled();
    expect(mockRecordSecondarySale).not.toHaveBeenCalled();
  });

  test("rejects a request with a missing signature (401)", async () => {
    const body = JSON.stringify(ETHEREUM_PAYLOAD);
    const res = await request(app)
      .post(`/api/v1/marketplaces/rarible/webhooks/${CONTRACT_ID}`)
      .set("Content-Type", "application/json")
      .send(body);

    expect(res.status).toBe(401);
    expect(res.body.code).toBe("invalid_signature");
  });

  test("rejects a signature produced with the wrong secret (401)", async () => {
    const res = await post(ETHEREUM_PAYLOAD, { secret: "not-the-real-secret" });

    expect(res.status).toBe(401);
    expect(mockBroadcastToContract).not.toHaveBeenCalled();
  });

  test("skips verification with a warning when no secret is configured", async () => {
    delete process.env.RARIBLE_WEBHOOK_SECRET;

    const res = await post(ETHEREUM_PAYLOAD, { signature: "" });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("recorded");
  });
});

describe("POST /api/v1/marketplaces/rarible/webhooks/:contractId — full pipeline", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      RARIBLE_WEBHOOK_SECRET: SECRET,
      RARIBLE_RELAYER_WALLET: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    };
    mockGetMarketplaceEvent.mockReturnValue(null);
    mockGetMarketplaceSettings.mockReturnValue({ contractId: CONTRACT_ID, autoRecordingEnabled: true });
    mockBuildTx.mockResolvedValue("AAAAAG5vbmNl");
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test("runs parse -> calculate -> record -> broadcast for an Ethereum sale", async () => {
    const res = await post(ETHEREUM_PAYLOAD);

    expect(res.status).toBe(200);

    // Royalty: 2.5e18 wei at the default 500 bps (5%) -> 1.25e17.
    expect(res.body.data.royaltyAmount).toBe("125000000000000000");

    expect(mockRecordSecondarySale).toHaveBeenCalledTimes(1);
    const sale = mockRecordSecondarySale.mock.calls[0];
    expect(sale[0]).toBe(CONTRACT_ID);
    expect(sale[1]).toBe(
      "ethereum/0xabcdef1234567890abcdef1234567890abcdef12/1337"
    );
    expect(sale[2]).toBe("0xSellerAddress0000000000000000000000001");
    expect(sale[3]).toBe("0xBuyerAddress00000000000000000000000002");
    expect(sale[4]).toBe(2500000000000000000n);
    expect(sale[5]).toBe("RARIBLE_EXTERNAL:ethereum");
    expect(sale[6]).toBe(125000000000000000n);
    expect(sale[7]).toBe(500);

    expect(mockBuildTx).toHaveBeenCalledTimes(1);
    expect(mockAddAuditLog).toHaveBeenCalledTimes(1);
    expect(mockBroadcastToContract).toHaveBeenCalledTimes(1);

    const broadcast = mockBroadcastToContract.mock.calls[0];
    expect(broadcast[0]).toBe(CONTRACT_ID);
    expect(broadcast[1]).toMatchObject({
      type: "secondary_sale_recorded",
      source: "rarible",
      chain: "ethereum",
      salePrice: "2500000000000000000",
      royaltyAmount: "125000000000000000",
    });
  });

  test("records a Polygon sale and tags it with the polygon chain", async () => {
    const res = await post(POLYGON_PAYLOAD);

    expect(res.status).toBe(200);
    expect(res.body.data.chain).toBe("polygon");

    // 1e18 at 5% -> 5e16.
    expect(res.body.data.royaltyAmount).toBe("50000000000000000");

    const sale = mockRecordSecondarySale.mock.calls[0];
    expect(sale[1]).toBe("polygon/0x1111111111111111111111111111111111111111/42");
    expect(sale[5]).toBe("RARIBLE_EXTERNAL:polygon");

    expect(mockBroadcastToContract.mock.calls[0][1].chain).toBe("polygon");
  });

  test("honours RARIBLE_ROYALTY_RATE_BPS when configured", async () => {
    process.env.RARIBLE_ROYALTY_RATE_BPS = "1000"; // 10%

    const res = await post(ETHEREUM_PAYLOAD);

    expect(res.body.data.royaltyAmount).toBe("250000000000000000");
    expect(mockRecordSecondarySale.mock.calls[0][7]).toBe(1000);
  });

  test("is idempotent: a redelivered event is not recorded twice", async () => {
    mockGetMarketplaceEvent.mockReturnValue({
      eventId: "ETHEREUM:0xabcdef1234567890abcdef1234567890abcdef12:1337:1",
      royaltyAmount: "125000000000000000",
    });

    const res = await post(ETHEREUM_PAYLOAD);

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("duplicate");
    expect(mockRecordSecondarySale).not.toHaveBeenCalled();
    expect(mockBroadcastToContract).not.toHaveBeenCalled();
  });

  test("skips processing when auto-recording is disabled for the contract", async () => {
    mockGetMarketplaceSettings.mockReturnValue({
      contractId: CONTRACT_ID,
      autoRecordingEnabled: false,
    });

    const res = await post(ETHEREUM_PAYLOAD);

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("auto_recording_disabled");
    expect(mockRecordSecondarySale).not.toHaveBeenCalled();
    expect(mockBroadcastToContract).not.toHaveBeenCalled();
  });

  test("still records the sale when the contract-call build fails after retries", async () => {
    mockBuildTx.mockRejectedValue(new Error("horizon unavailable"));

    const res = await post(ETHEREUM_PAYLOAD);

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("recorded");
    expect(res.body.data.xdr).toBeNull();
    expect(mockRecordSecondarySale).toHaveBeenCalledTimes(1);
    expect(mockBroadcastToContract).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/v1/marketplaces/rarible/webhooks — payload validation", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv, RARIBLE_WEBHOOK_SECRET: SECRET };
    mockGetMarketplaceEvent.mockReturnValue(null);
    mockGetMarketplaceSettings.mockReturnValue({ contractId: CONTRACT_ID, autoRecordingEnabled: true });
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test("rejects an unsupported chain (400)", async () => {
    const res = await post({
      ...ETHEREUM_PAYLOAD,
      data: { ...ETHEREUM_PAYLOAD.data, blockchain: "SOLANA" },
    });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_payload");
    expect(mockRecordSecondarySale).not.toHaveBeenCalled();
  });

  test("rejects a payload missing the sale price (400)", async () => {
    const { price, ...withoutPrice } = ETHEREUM_PAYLOAD.data;
    const res = await post({ ...ETHEREUM_PAYLOAD, data: withoutPrice });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_payload");
  });

  test("accepts the contract id from the body when the URL has none", async () => {
    const body = JSON.stringify({ ...ETHEREUM_PAYLOAD, contractId: CONTRACT_ID });
    const res = await request(app)
      .post("/api/v1/marketplaces/rarible/webhooks")
      .set("Content-Type", "application/json")
      .set("X-Rarible-Signature", sign(body))
      .send(body);

    expect(res.status).toBe(200);
    expect(mockRecordSecondarySale.mock.calls[0][0]).toBe(CONTRACT_ID);
  });

  test("rejects a request with no contract id at all (400)", async () => {
    const body = JSON.stringify(ETHEREUM_PAYLOAD);
    const res = await request(app)
      .post("/api/v1/marketplaces/rarible/webhooks")
      .set("Content-Type", "application/json")
      .set("X-Rarible-Signature", sign(body))
      .send(body);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("missing_contract_id");
  });
});

describe("Rarible marketplace settings endpoints", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetMarketplaceSettings.mockReturnValue({ contractId: CONTRACT_ID, autoRecordingEnabled: true });
    mockSaveMarketplaceSettings.mockImplementation((contractId, enabled) => ({
      contractId,
      autoRecordingEnabled: enabled,
    }));
  });

  test("GET returns the current settings", async () => {
    const res = await request(app).get(`/api/v1/marketplaces/rarible/settings/${CONTRACT_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ contractId: CONTRACT_ID, autoRecordingEnabled: true });
  });

  test("POST persists autoRecordingEnabled", async () => {
    const res = await request(app)
      .post(`/api/v1/marketplaces/rarible/settings/${CONTRACT_ID}`)
      .send({ autoRecordingEnabled: false });

    expect(res.status).toBe(200);
    expect(mockSaveMarketplaceSettings).toHaveBeenCalledWith(CONTRACT_ID, false);
  });

  test("POST rejects a non-boolean autoRecordingEnabled (400)", async () => {
    const res = await request(app)
      .post(`/api/v1/marketplaces/rarible/settings/${CONTRACT_ID}`)
      .send({ autoRecordingEnabled: "yes" });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("validation_error");
    expect(mockSaveMarketplaceSettings).not.toHaveBeenCalled();
  });
});
