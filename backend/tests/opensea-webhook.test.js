/**
 * Tests for the OpenSea webhook route — closes #928.
 *
 * Covers: signature validation (valid accepted, invalid/missing rejected
 * with 401), a full simulated webhook POST asserting the entire pipeline
 * runs (parse -> calculate -> record via the contract integration point
 * (mocked) -> broadcast via WebSocket (mocked)), and the marketplace
 * auto-recording settings endpoints.
 */
import { jest, describe, test, expect, beforeEach, afterEach } from "@jest/globals";
import request from "supertest";
import crypto from "crypto";

const mockGetMarketplaceSettings = jest.fn(() => ({ contractId: "C", autoRecordingEnabled: true }));
const mockSaveMarketplaceSettings = jest.fn();

await jest.unstable_mockModule("../src/database/marketplace-events.js", () => ({
  getMarketplaceEvent: jest.fn(() => null),
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

const express = (await import("express")).default;
const { openseaRouter } = await import("../src/routes/marketplaces/opensea.js");

const app = express();
// No express.json() globally — the router captures the raw body itself for
// HMAC verification, same pattern as routes/kyc-webhooks.js.
app.use("/api/v1/marketplaces/opensea", openseaRouter);
app.use((err, _req, res, _next) => {
  res.status(500).json({ error: err.message ?? "Internal server error" });
});

const CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const SECRET = "test-opensea-webhook-secret";

const SAMPLE_PAYLOAD = {
  event_type: "item_sold",
  payload: {
    event_id: "3f9c1a2e-4b5d-4e6f-8a9b-0c1d2e3f4a5b",
    item: { nft_id: "ethereum/0xabc1230000000000000000000000000000dead/1337" },
    collection: { slug: "my-royalty-collection" },
    sale_price: "2500000000000000000",
    maker: "0xSellerAddress0000000000000000000000001",
    taker: "0xBuyerAddress00000000000000000000000002",
  },
};

function sign(body, secret = SECRET) {
  return crypto.createHmac("sha256", secret).update(body).digest("hex");
}

describe("POST /api/v1/marketplaces/opensea/webhooks/:contractId — signature validation", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv, OPENSEA_WEBHOOK_SECRET: SECRET };
    mockGetMarketplaceSettings.mockReturnValue({ contractId: CONTRACT_ID, autoRecordingEnabled: true });
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test("accepts a request with a valid signature", async () => {
    const body = JSON.stringify(SAMPLE_PAYLOAD);
    const res = await request(app)
      .post(`/api/v1/marketplaces/opensea/webhooks/${CONTRACT_ID}`)
      .set("Content-Type", "application/json")
      .set("X-OpenSea-Signature", sign(body))
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test("rejects a request with an invalid signature with 401", async () => {
    const body = JSON.stringify(SAMPLE_PAYLOAD);
    const res = await request(app)
      .post(`/api/v1/marketplaces/opensea/webhooks/${CONTRACT_ID}`)
      .set("Content-Type", "application/json")
      .set("X-OpenSea-Signature", "0000deadbeef0000deadbeef0000deadbeef0000deadbeef0000deadbeef00")
      .send(body);

    expect(res.status).toBe(401);
    expect(res.body.code).toBe("invalid_signature");
    expect(mockRecordSecondarySale).not.toHaveBeenCalled();
  });

  test("rejects a request with a missing signature with 401", async () => {
    const body = JSON.stringify(SAMPLE_PAYLOAD);
    const res = await request(app)
      .post(`/api/v1/marketplaces/opensea/webhooks/${CONTRACT_ID}`)
      .set("Content-Type", "application/json")
      .send(body);

    expect(res.status).toBe(401);
    expect(res.body.code).toBe("invalid_signature");
    expect(mockRecordSecondarySale).not.toHaveBeenCalled();
  });

  test("rejects a signature computed with the wrong secret", async () => {
    const body = JSON.stringify(SAMPLE_PAYLOAD);
    const res = await request(app)
      .post(`/api/v1/marketplaces/opensea/webhooks/${CONTRACT_ID}`)
      .set("Content-Type", "application/json")
      .set("X-OpenSea-Signature", sign(body, "wrong-secret"))
      .send(body);

    expect(res.status).toBe(401);
  });

  test("allows the request through when no webhook secret is configured (dev mode)", async () => {
    delete process.env.OPENSEA_WEBHOOK_SECRET;
    const body = JSON.stringify(SAMPLE_PAYLOAD);

    const res = await request(app)
      .post(`/api/v1/marketplaces/opensea/webhooks/${CONTRACT_ID}`)
      .set("Content-Type", "application/json")
      .send(body);

    expect(res.status).toBe(200);
  });
});

describe("POST /api/v1/marketplaces/opensea/webhooks/:contractId — full pipeline", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv, OPENSEA_WEBHOOK_SECRET: SECRET };
    mockGetMarketplaceSettings.mockReturnValue({ contractId: CONTRACT_ID, autoRecordingEnabled: true });
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test("runs parse -> calculate -> record -> broadcast end to end", async () => {
    const body = JSON.stringify(SAMPLE_PAYLOAD);
    const res = await request(app)
      .post(`/api/v1/marketplaces/opensea/webhooks/${CONTRACT_ID}`)
      .set("Content-Type", "application/json")
      .set("X-OpenSea-Signature", sign(body))
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("recorded");
    expect(res.body.data.royaltyAmount).toBe("125000000000000000"); // 5% of 2.5e18

    expect(mockRecordSecondarySale).toHaveBeenCalledTimes(1);
    expect(mockAddAuditLog).toHaveBeenCalledWith(
      CONTRACT_ID,
      "secondary_sale_recorded",
      "opensea_webhook",
      expect.objectContaining({ source: "opensea" })
    );
    expect(mockBroadcastToContract).toHaveBeenCalledWith(
      CONTRACT_ID,
      expect.objectContaining({ type: "secondary_sale_recorded", royaltyStatus: "pending" })
    );
  });

  test("400 when the payload is missing required fields", async () => {
    const body = JSON.stringify({ payload: { item: {} } });
    const res = await request(app)
      .post(`/api/v1/marketplaces/opensea/webhooks/${CONTRACT_ID}`)
      .set("Content-Type", "application/json")
      .set("X-OpenSea-Signature", sign(body))
      .send(body);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_payload");
    expect(mockRecordSecondarySale).not.toHaveBeenCalled();
  });
});

describe("Marketplace auto-recording settings (#928 point 7)", () => {
  beforeEach(() => jest.clearAllMocks());

  test("GET /settings/:contractId returns the current setting", async () => {
    mockGetMarketplaceSettings.mockReturnValue({ contractId: CONTRACT_ID, autoRecordingEnabled: true, updatedAt: null });

    const res = await request(app).get(`/api/v1/marketplaces/opensea/settings/${CONTRACT_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.data.autoRecordingEnabled).toBe(true);
  });

  test("POST /settings/:contractId saves the toggle", async () => {
    mockSaveMarketplaceSettings.mockReturnValue({ contractId: CONTRACT_ID, autoRecordingEnabled: false, updatedAt: "2026-09-24T00:00:00.000Z" });

    const res = await request(app)
      .post(`/api/v1/marketplaces/opensea/settings/${CONTRACT_ID}`)
      .send({ autoRecordingEnabled: false });

    expect(res.status).toBe(200);
    expect(mockSaveMarketplaceSettings).toHaveBeenCalledWith(CONTRACT_ID, false);
  });

  test("POST /settings/:contractId rejects a non-boolean value", async () => {
    const res = await request(app)
      .post(`/api/v1/marketplaces/opensea/settings/${CONTRACT_ID}`)
      .send({ autoRecordingEnabled: "yes" });

    expect(res.status).toBe(400);
    expect(mockSaveMarketplaceSettings).not.toHaveBeenCalled();
  });
});
