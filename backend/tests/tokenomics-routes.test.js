/**
 * Integration tests for the token economics & vesting analytics API (#1062).
 *
 * The services are pure/deterministic so these tests exercise the real
 * implementation through the shared test app.
 */

import { describe, it, expect } from "@jest/globals";
import request from "supertest";
import app from "./app.js";

const TGE = "2025-01-01T00:00:00.000Z";

const CONFIG = {
  tokenSymbol: "SRS",
  totalSupply: 1000,
  tgeDate: TGE,
  allocations: [
    { name: "Team", amount: 1000, tgePercent: 10, cliffMonths: 6, vestingMonths: 12 },
  ],
};

const SCHEDULE = {
  label: "Team",
  beneficiary: "GABC",
  totalAmount: 1200,
  releasedAmount: 0,
  startDate: TGE,
  cliffMonths: 6,
  vestingMonths: 12,
};

describe("Tokenomics API", () => {
  it("POST /api/v1/tokenomics/model returns the economics model", async () => {
    const res = await request(app)
      .post("/api/v1/tokenomics/model")
      .send({ config: CONFIG, options: { asOf: TGE, horizonMonths: 24 } });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.totalSupply).toBe(1000);
    expect(res.body.data.current.circulatingSupply).toBe(100);
    expect(res.body.data.dilution.dilutionPercent).toBe(90);
  });

  it("POST /api/v1/tokenomics/model rejects an invalid config", async () => {
    const res = await request(app)
      .post("/api/v1/tokenomics/model")
      .send({ config: { totalSupply: 0, allocations: [] } });

    expect(res.status).toBe(400);
    expect(res.body.success).not.toBe(true);
  });

  it("POST /api/v1/tokenomics/simulate returns base vs scenario", async () => {
    const res = await request(app)
      .post("/api/v1/tokenomics/simulate")
      .send({
        config: CONFIG,
        scenario: {
          allocations: [
            { name: "Team", amount: 1000, tgePercent: 50, cliffMonths: 6, vestingMonths: 12 },
          ],
        },
        options: { asOf: TGE, horizonMonths: 24 },
      });

    expect(res.status).toBe(200);
    expect(res.body.data.base.projection.endCirculating).toBe(1000);
    expect(res.body.data.comparison).toHaveProperty("dilutionDelta");
  });

  it("POST /api/v1/tokenomics/vesting returns aggregate analytics", async () => {
    const res = await request(app)
      .post("/api/v1/tokenomics/vesting")
      .send({ schedules: [SCHEDULE], options: { asOf: "2026-01-01T00:00:00.000Z" } });

    expect(res.status).toBe(200);
    expect(res.body.data.totalAmount).toBe(1200);
    expect(res.body.data.totalVested).toBeCloseTo(605, 0);
    expect(res.body.data.scheduleCount).toBe(1);
  });

  it("POST /api/v1/tokenomics/vesting rejects a non-array body", async () => {
    const res = await request(app)
      .post("/api/v1/tokenomics/vesting")
      .send({ schedules: "nope" });

    expect(res.status).toBe(400);
  });

  it("POST /api/v1/tokenomics/vesting/simulate compares scenarios", async () => {
    const res = await request(app)
      .post("/api/v1/tokenomics/vesting/simulate")
      .send({
        schedule: SCHEDULE,
        overrides: { cliffMonths: 0, vestingMonths: 6 },
        options: { asOf: TGE, horizonMonths: 12 },
      });

    expect(res.status).toBe(200);
    expect(res.body.data.scenario.vestedAtHorizon).toBe(1200);
    expect(res.body.data.comparison.vestedDelta).toBeCloseTo(595, 0);
  });

  it("POST /api/v1/tokenomics/vesting/schedule returns a single curve", async () => {
    const res = await request(app)
      .post("/api/v1/tokenomics/vesting/schedule")
      .send({ schedule: SCHEDULE, options: { intervalDays: 30 } });

    expect(res.status).toBe(200);
    expect(res.body.data.cliffDate).toBe("2025-07-01T00:00:00.000Z");
    expect(res.body.data.points.length).toBeGreaterThan(0);
  });

  it("POST /api/v1/tokenomics/export/supply returns a CSV attachment", async () => {
    const res = await request(app)
      .post("/api/v1/tokenomics/export/supply")
      .send({ config: CONFIG, options: { asOf: TGE, horizonMonths: 12 } });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.text.split("\r\n")[0]).toBe(
      "Date,Total Supply,Circulating Supply,Locked Supply,Circulating %",
    );
  });
});
