import { jest, describe, test, expect } from "@jest/globals";
import request from "supertest";

const mockGetContributorEarningsHistory = jest.fn();
const mockGetContributorEarningsEvents = jest.fn();
const mockGetContributorContracts = jest.fn();
const mockGetContributorPayoutRecords = jest.fn();

await jest.unstable_mockModule("../src/database/analytics.js", () => ({
  getContributorEarningsHistory: mockGetContributorEarningsHistory,
  getContributorEarningsEvents: mockGetContributorEarningsEvents,
  getContributorContracts: mockGetContributorContracts,
  getContributorPayoutRecords: mockGetContributorPayoutRecords,
}));

import express from "express";
const { earningsHistoryRouter } = await import("../src/routes/earnings-history.js");

const app = express();
app.use(express.json());
app.use("/api/v1", earningsHistoryRouter);

const WALLET = "GAPTAQKSMN2ILFVHXDE5V274BUPC6QCRMJZYJFNGW7ENT2X3BQOS4M3C";

describe("Earnings history API", () => {
  test("GET /earnings-history/:walletAddress returns snapshots and events", async () => {
    mockGetContributorEarningsHistory.mockReturnValue([
      { date: "2026-07-01", contractId: "C123", amount: 12.5 },
    ]);
    mockGetContributorEarningsEvents.mockReturnValue([
      { type: "contract_added", contractId: "C123", date: "2026-07-01", label: "New contract" },
    ]);
    mockGetContributorContracts.mockReturnValue(["C123"]);

    const res = await request(app).get(`/api/v1/earnings-history/${WALLET}?start=2026-07-01&end=2026-07-31`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.snapshots).toHaveLength(1);
    expect(res.body.data.events).toHaveLength(1);
    expect(res.body.data.contracts).toEqual(["C123"]);
  });

  test("rejects invalid wallet addresses", async () => {
    const res = await request(app).get("/api/v1/earnings-history/not-a-wallet");
    expect(res.status).toBe(400);
  });

  test("rejects inverted date ranges", async () => {
    const res = await request(app).get(
      `/api/v1/earnings-history/${WALLET}?start=2026-08-01&end=2026-07-01`,
    );
    expect(res.status).toBe(400);
  });

  test("GET /earnings-history/:walletAddress/export returns CSV file with accurate payout data", async () => {
    mockGetContributorPayoutRecords.mockReturnValue([
      {
        payoutDate: "2026-07-20T10:00:00Z",
        transactionId: "tx_abc123",
        royaltyType: "distribute",
        amount: "150.00",
        contractId: "C123",
      },
    ]);

    const res = await request(app).get(
      `/api/v1/earnings-history/${WALLET}/export?start=2026-07-01&end=2026-07-31`
    );

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toContain("attachment; filename=");
    expect(res.text).toContain('"Payout Date","Transaction ID","Royalty Type","Amount"');
    expect(res.text).toContain('"2026-07-20T10:00:00Z","tx_abc123","distribute","150.00"');
  });

  test("GET /earnings-history/:walletAddress/export filters by royaltyType", async () => {
    mockGetContributorPayoutRecords.mockReturnValue([
      {
        payoutDate: "2026-07-20T10:00:00Z",
        transactionId: "tx_abc123",
        royaltyType: "distribute",
        amount: "150.00",
      },
      {
        payoutDate: "2026-07-21T10:00:00Z",
        transactionId: "tx_def456",
        royaltyType: "secondary_royalty",
        amount: "50.00",
      },
    ]);

    const res = await request(app).get(
      `/api/v1/earnings-history/${WALLET}/export?start=2026-07-01&end=2026-07-31&royaltyType=distribute`
    );

    expect(res.status).toBe(200);
    expect(res.text).toContain('"distribute"');
    expect(res.text).not.toContain('"secondary_royalty"');
  });

  test("GET /earnings-history/:walletAddress/export streams rows instead of buffering the whole file (#766)", async () => {
    const records = Array.from({ length: 500 }, (_, i) => ({
      payoutDate: `2026-07-${String((i % 28) + 1).padStart(2, "0")}T10:00:00Z`,
      transactionId: `tx_${i}`,
      royaltyType: "distribute",
      amount: "10.00",
    }));
    mockGetContributorPayoutRecords.mockReturnValue(records);

    const res = await request(app).get(
      `/api/v1/earnings-history/${WALLET}/export?start=2026-07-01&end=2026-07-31`
    );

    expect(res.status).toBe(200);
    expect(res.headers["transfer-encoding"]).toBe("chunked");
    const lines = res.text.trim().split("\n");
    expect(lines).toHaveLength(records.length + 1);
    expect(lines[0]).toBe('"Payout Date","Transaction ID","Royalty Type","Amount"');
    expect(lines[1]).toBe('"2026-07-01T10:00:00Z","tx_0","distribute","10.00"');
  });
});

