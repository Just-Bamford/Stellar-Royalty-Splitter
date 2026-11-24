/**
 * limit / offset validation on the snapshot list routes (#1373).
 */

import { jest, describe, test, expect, beforeEach } from "@jest/globals";
import request from "supertest";
import express from "express";

const mockGetAllSnapshots = jest.fn(() => []);
const mockListSnapshots = jest.fn(() => []);

await jest.unstable_mockModule("../src/middleware/rbac.js", () => ({
  attachRole: (_req, _res, next) => next(),
  requireRole: () => (_req, _res, next) => next(),
  requireAdminBearerOrRole: () => (_req, _res, next) => next(),
}));

await jest.unstable_mockModule("../src/database/index.js", () => ({
  addAuditLog: jest.fn(),
}));

await jest.unstable_mockModule("../src/database/contract-snapshots.js", () => ({
  createSnapshot: jest.fn(),
  listSnapshots: mockListSnapshots,
  getSnapshot: jest.fn(),
  verifySnapshotIntegrity: jest.fn(),
  countSnapshots: jest.fn(() => 0),
  getAllSnapshots: mockGetAllSnapshots,
  pruneSnapshots: jest.fn(),
}));

await jest.unstable_mockModule("../src/cache.js", () => ({
  cacheGet: jest.fn(() => undefined),
  cacheSet: jest.fn(),
  cacheKey: (...parts) => parts.join(":"),
}));

const { snapshotRouter, parsePagination } = await import("../src/routes/snapshots.js");

const app = express();
app.use(express.json());
app.use("/api/v1/snapshots", snapshotRouter);

describe("parsePagination", () => {
  const opts = { defaultLimit: 100, maxLimit: 1000 };

  test("uses the defaults when nothing is given", () => {
    expect(parsePagination({}, opts)).toEqual({ limit: 100, offset: 0 });
  });

  test.each([
    [{ offset: "-5" }, 0],
    [{ offset: "-1" }, 0],
    [{ offset: "abc" }, 0],
    [{ offset: "" }, 0],
    [{ offset: "0" }, 0],
    [{ offset: "25" }, 25],
    [{ offset: "7.9" }, 7],
  ])("offset %j becomes %i (never negative)", (query, expected) => {
    expect(parsePagination(query, opts).offset).toBe(expected);
  });

  test.each([
    [{ limit: "-1" }, 1],
    [{ limit: "-500" }, 1],
    [{ limit: "0" }, 100],
    [{ limit: "abc" }, 100],
    [{ limit: "50" }, 50],
    [{ limit: "5000" }, 1000],
  ])("limit %j becomes %i (between 1 and the maximum)", (query, expected) => {
    expect(parsePagination(query, opts).limit).toBe(expected);
  });
});

describe("GET /api/v1/snapshots/all", () => {
  beforeEach(() => jest.clearAllMocks());

  test("does not pass a negative offset to the database", async () => {
    const res = await request(app).get("/api/v1/snapshots/all?offset=-5");

    expect(res.status).toBe(200);
    expect(mockGetAllSnapshots).toHaveBeenCalledWith({ limit: 100, offset: 0 });
    expect(res.body.pagination).toEqual({ limit: 100, offset: 0 });
  });

  test("does not pass a negative limit to the database", async () => {
    const res = await request(app).get("/api/v1/snapshots/all?limit=-1");

    expect(res.status).toBe(200);
    expect(mockGetAllSnapshots).toHaveBeenCalledWith({ limit: 1, offset: 0 });
  });

  test("passes valid values through and caps the limit", async () => {
    await request(app).get("/api/v1/snapshots/all?limit=20&offset=40");
    await request(app).get("/api/v1/snapshots/all?limit=99999");

    expect(mockGetAllSnapshots).toHaveBeenNthCalledWith(1, { limit: 20, offset: 40 });
    expect(mockGetAllSnapshots).toHaveBeenNthCalledWith(2, { limit: 1000, offset: 0 });
  });
});

describe("GET /api/v1/snapshots/:contractId", () => {
  beforeEach(() => jest.clearAllMocks());

  test("applies the same limit/offset validation", async () => {
    const res = await request(app).get("/api/v1/snapshots/CABC?offset=-5&limit=-1");

    expect(res.status).toBe(200);
    expect(mockListSnapshots).toHaveBeenCalledWith("CABC", { limit: 1, offset: 0 });
  });

  test("keeps its own default and maximum limit", async () => {
    await request(app).get("/api/v1/snapshots/CABC");
    await request(app).get("/api/v1/snapshots/CABC?limit=9999");

    expect(mockListSnapshots).toHaveBeenNthCalledWith(1, "CABC", { limit: 50, offset: 0 });
    expect(mockListSnapshots).toHaveBeenNthCalledWith(2, "CABC", { limit: 500, offset: 0 });
  });
});
