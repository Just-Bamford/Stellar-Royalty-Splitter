import { jest, describe, test, expect, beforeEach } from "@jest/globals";
import request from "supertest";

// Mock database
const mockGetContributorStatus = jest.fn();
const mockListContributorStatuses = jest.fn();
const mockSetContributorStatus = jest.fn();
const mockAddAuditLog = jest.fn();

await jest.unstable_mockModule("../src/database/contributor-status.js", () => ({
  getContributorStatus: mockGetContributorStatus,
  listContributorStatuses: mockListContributorStatuses,
  setContributorStatus: mockSetContributorStatus,
}));

await jest.unstable_mockModule("../src/database/index.js", () => ({
  initializeDatabase: jest.fn(),
  getMigrationVersion: jest.fn(() => 9),
  addAuditLog: mockAddAuditLog,
}));

await jest.unstable_mockModule("../src/middleware/rbac.js", () => ({
  attachRole: (_req, _res, next) => next(),
  requireRole: () => (_req, _res, next) => next(),
  ROLES: ["viewer", "collaborator", "operator", "admin"],
}));

const express = (await import("express")).default;
const { contributorStatusRouter } = await import("../src/routes/contributor-status.js");

const app = express();
app.use(express.json());
app.use("/api/v1/contributor-status", contributorStatusRouter);

const VALID_CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const VALID_ADDRESS = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";

describe("GET /api/v1/contributor-status/:contractId", () => {
  beforeEach(() => jest.clearAllMocks());

  test("returns list of non-active contributors", async () => {
    mockListContributorStatuses.mockReturnValue([
      { contractId: VALID_CONTRACT, address: VALID_ADDRESS, status: "suspended", reason: "test" },
    ]);

    const res = await request(app).get(`/api/v1/contributor-status/${VALID_CONTRACT}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(1);
  });

  test("returns 400 for invalid contract ID", async () => {
    const res = await request(app).get("/api/v1/contributor-status/INVALID");
    expect(res.status).toBe(400);
  });
});

describe("GET /api/v1/contributor-status/:contractId/:address", () => {
  beforeEach(() => jest.clearAllMocks());

  test("returns status record when found", async () => {
    mockGetContributorStatus.mockReturnValue({
      contractId: VALID_CONTRACT,
      address: VALID_ADDRESS,
      status: "suspended",
      reason: "test",
      suspendedAt: "2024-01-01T00:00:00.000Z",
      deactivatedAt: null,
      updatedBy: null,
    });

    const res = await request(app).get(
      `/api/v1/contributor-status/${VALID_CONTRACT}/${VALID_ADDRESS}`
    );
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("suspended");
  });

  test("returns active default when no record exists", async () => {
    mockGetContributorStatus.mockReturnValue(null);

    const res = await request(app).get(
      `/api/v1/contributor-status/${VALID_CONTRACT}/${VALID_ADDRESS}`
    );
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("active");
  });

  test("returns 400 for invalid address", async () => {
    const res = await request(app).get(
      `/api/v1/contributor-status/${VALID_CONTRACT}/INVALID_ADDR`
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /api/v1/contributor-status/:contractId/:address", () => {
  beforeEach(() => jest.clearAllMocks());

  test("suspends a contributor", async () => {
    const record = {
      contractId: VALID_CONTRACT,
      address: VALID_ADDRESS,
      status: "suspended",
      reason: "violation",
      suspendedAt: "2024-01-01T00:00:00.000Z",
      deactivatedAt: null,
      updatedBy: VALID_ADDRESS,
      updatedAt: "2024-01-01T00:00:00.000Z",
    };
    mockSetContributorStatus.mockReturnValue(record);

    const res = await request(app)
      .post(`/api/v1/contributor-status/${VALID_CONTRACT}/${VALID_ADDRESS}`)
      .send({ status: "suspended", reason: "violation", updatedBy: VALID_ADDRESS });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe("suspended");
    expect(mockAddAuditLog).toHaveBeenCalledWith(
      VALID_CONTRACT,
      "contributor_suspended",
      VALID_ADDRESS,
      expect.objectContaining({ address: VALID_ADDRESS, status: "suspended" })
    );
  });

  test("returns 400 for invalid status value", async () => {
    const res = await request(app)
      .post(`/api/v1/contributor-status/${VALID_CONTRACT}/${VALID_ADDRESS}`)
      .send({ status: "banned" });
    expect(res.status).toBe(400);
  });

  test("reactivates a previously suspended contributor", async () => {
    const record = {
      contractId: VALID_CONTRACT,
      address: VALID_ADDRESS,
      status: "active",
      reason: null,
      suspendedAt: null,
      deactivatedAt: null,
      updatedBy: VALID_ADDRESS,
      updatedAt: "2024-01-02T00:00:00.000Z",
    };
    mockSetContributorStatus.mockReturnValue(record);

    const res = await request(app)
      .post(`/api/v1/contributor-status/${VALID_CONTRACT}/${VALID_ADDRESS}`)
      .send({ status: "active" });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("active");
  });
});
