import { jest, describe, test, expect, beforeEach } from "@jest/globals";
import request from "supertest";
import express from "express";

const mockCreateVestingSchedule = jest.fn();
const mockCalculateVestedAmount = jest.fn();
const mockGetVestingSchedulesByContract = jest.fn();
const mockAddAuditEntry = jest.fn();

await jest.unstable_mockModule("../src/middleware/rbac.js", () => ({
  attachRole: (req, _res, next) => {
    req.role = "admin";
    req.user = { walletAddress: "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H", role: "admin" };
    next();
  },
  requireRole: () => (_req, _res, next) => next(),
  ROLES: ["viewer", "collaborator", "operator", "admin"],
}));

await jest.unstable_mockModule("../src/database/index.js", () => ({
  createVestingSchedule: mockCreateVestingSchedule,
  calculateVestedAmount: mockCalculateVestedAmount,
  releaseVestedTokens: jest.fn(),
  getVestingSchedule: jest.fn(),
  getVestingSchedulesByBeneficiary: jest.fn(() => []),
  getVestingSchedulesByContract: mockGetVestingSchedulesByContract,
  getVestingReleaseHistory: jest.fn(() => []),
  getSchedulesWithReleasableTokens: jest.fn(() => []),
  cancelVestingSchedule: jest.fn(),
  getVestingStatistics: jest.fn(),
  addAuditEntry: mockAddAuditEntry,
}));

await jest.unstable_mockModule("../src/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const { vestingRouter } = await import("../src/routes/vesting.js");

const app = express();
app.use(express.json());
app.use("/api/v1", vestingRouter);

const VALID_CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const VALID_TOKEN_ADDRESS = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const VALID_BENEFICIARY = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";

describe("Vesting Routes Contract ID Validation (#1217)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("GET /api/v1/vesting/contract/:contractId", () => {
    test("rejects malformed contractId with 400 invalid_contract_id", async () => {
      const res = await request(app).get("/api/v1/vesting/contract/not-a-contract-id");

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_contract_id");
      expect(mockGetVestingSchedulesByContract).not.toHaveBeenCalled();
    });

    test("accepts valid contractId format and returns schedules with 200", async () => {
      mockGetVestingSchedulesByContract.mockReturnValue([
        { id: 1, contractId: VALID_CONTRACT_ID },
      ]);
      mockCalculateVestedAmount.mockReturnValue({ vested: 500 });

      const res = await request(app).get(`/api/v1/vesting/contract/${VALID_CONTRACT_ID}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockGetVestingSchedulesByContract).toHaveBeenCalledWith(VALID_CONTRACT_ID);
    });
  });

  describe("POST /api/v1/vesting/create", () => {
    const validPayload = {
      contractId: VALID_CONTRACT_ID,
      beneficiary: VALID_BENEFICIARY,
      totalAmount: 1000,
      tokenAddress: VALID_TOKEN_ADDRESS,
      startTime: "2026-01-01T00:00:00.000Z",
      cliffDuration: 86400,
      vestingDuration: 604800,
    };

    test("rejects malformed contractId in request body with 400 invalid_contract_id", async () => {
      const res = await request(app)
        .post("/api/v1/vesting/create")
        .send({ ...validPayload, contractId: "invalid-id" });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_contract_id");
      expect(mockCreateVestingSchedule).not.toHaveBeenCalled();
    });

    test("accepts valid contractId and creates vesting schedule with 200", async () => {
      mockCreateVestingSchedule.mockReturnValue(42);

      const res = await request(app)
        .post("/api/v1/vesting/create")
        .send(validPayload);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.scheduleId).toBe(42);
      expect(mockCreateVestingSchedule).toHaveBeenCalled();
    });
  });
});
