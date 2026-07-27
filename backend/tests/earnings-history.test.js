import { jest, describe, test, expect } from "@jest/globals";
import request from "supertest";

const mockGetContributorEarningsHistory = jest.fn();
const mockGetContributorEarningsEvents = jest.fn();
const mockGetContributorContracts = jest.fn();

await jest.unstable_mockModule("../src/database/analytics.js", () => ({
  getContributorEarningsHistory: mockGetContributorEarningsHistory,
  getContributorEarningsEvents: mockGetContributorEarningsEvents,
  getContributorContracts: mockGetContributorContracts,
}));

import express from "express";
const { earningsHistoryRouter } = await import("../src/routes/earnings-history.js");

const app = express();
app.use(express.json());
app.use("/api/v1", earningsHistoryRouter);

const WALLET = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

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
});
