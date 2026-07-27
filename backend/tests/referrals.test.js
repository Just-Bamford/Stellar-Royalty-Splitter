/**
 * Tests for the contributor referral tracking routes — closes #603.
 *
 * Covers: link generation, referral registration, dashboard stats,
 *         mine/status queries, admin activate/bonus/list, and all
 *         validation + auth error paths.
 */
import { jest, describe, test, expect, beforeEach } from "@jest/globals";
import request from "supertest";

// ─── Mock database helpers ────────────────────────────────────────────────────

const mockGenerateReferralLink = jest.fn();
const mockGetReferralLinkByWallet = jest.fn();
const mockRegisterReferral = jest.fn();
const mockActivateReferral = jest.fn();
const mockGetReferralByReferred = jest.fn();
const mockGetReferralsByReferrer = jest.fn();
const mockCountReferralsByReferrer = jest.fn();
const mockAwardReferralBonus = jest.fn();
const mockGetReferralDashboard = jest.fn();
const mockGetAllReferrals = jest.fn();
const mockCountAllReferrals = jest.fn();

await jest.unstable_mockModule("../src/database/referrals.js", () => ({
  generateReferralLink: mockGenerateReferralLink,
  getReferralLinkByWallet: mockGetReferralLinkByWallet,
  registerReferral: mockRegisterReferral,
  activateReferral: mockActivateReferral,
  getReferralByReferred: mockGetReferralByReferred,
  getReferralsByReferrer: mockGetReferralsByReferrer,
  countReferralsByReferrer: mockCountReferralsByReferrer,
  awardReferralBonus: mockAwardReferralBonus,
  getReferralDashboard: mockGetReferralDashboard,
  getAllReferrals: mockGetAllReferrals,
  countAllReferrals: mockCountAllReferrals,
  DEFAULT_REFERRAL_BONUS_STROOPS: 50_000_000,
}));

await jest.unstable_mockModule("../src/database/index.js", () => ({
  initializeDatabase: jest.fn(),
  getMigrationVersion: jest.fn(() => 9),
}));

// ─── Build minimal Express app ────────────────────────────────────────────────

import express from "express";
const { referralsRouter } = await import("../src/routes/referrals.js");

const app = express();
app.use(express.json());
app.use("/api/v1/referrals", referralsRouter);
app.use((err, _req, res, _next) => {
  res.status(500).json({ error: err.message ?? "Internal server error" });
});

// ─── Test data ────────────────────────────────────────────────────────────────

const REFERRER = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const REFERRED = "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
const REF_CODE  = "REF-3A9F21B04C7E";
const ADMIN_TOKEN = "test-admin-token";
const TIMESTAMP = "2026-07-26T10:00:00.000Z";

const baseLink = (overrides = {}) => ({
  id: 1,
  walletAddress: REFERRER,
  referralCode: REF_CODE,
  createdAt: TIMESTAMP,
  ...overrides,
});

const baseReferral = (overrides = {}) => ({
  id: 1,
  referrerAddress: REFERRER,
  referredAddress: REFERRED,
  referralCode: REF_CODE,
  status: "pending",
  createdAt: TIMESTAMP,
  activatedAt: null,
  ...overrides,
});

const baseBonus = (overrides = {}) => ({
  id: 1,
  referralId: 1,
  referrerAddress: REFERRER,
  bonusAmountStroops: 50_000_000,
  reason: "First distribution by referred contributor",
  awardedAt: TIMESTAMP,
  ...overrides,
});

const baseDashboard = (overrides = {}) => ({
  referralCode: REF_CODE,
  totalReferrals: 3,
  pendingReferrals: 1,
  activeReferrals: 2,
  bonusPaidReferrals: 0,
  totalBonusStroops: 100_000_000,
  totalBonusXlm: "10.0000000",
  referrals: [baseReferral(), baseReferral({ id: 2, status: "active" })],
  pagination: { total: 3, limit: 50, offset: 0 },
  ...overrides,
});

// ─── POST /api/v1/referrals/link ─────────────────────────────────────────────

describe("POST /api/v1/referrals/link", () => {
  beforeEach(() => jest.clearAllMocks());

  test("generates a referral link and returns 201", async () => {
    mockGenerateReferralLink.mockReturnValue(baseLink());

    const res = await request(app)
      .post("/api/v1/referrals/link")
      .send({ walletAddress: REFERRER });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.referralCode).toBe(REF_CODE);
    expect(res.body.data.referralUrl).toContain(REF_CODE);
    expect(mockGenerateReferralLink).toHaveBeenCalledWith(REFERRER);
  });

  test("is idempotent — returns existing code on repeat call", async () => {
    mockGenerateReferralLink.mockReturnValue(baseLink());

    const res1 = await request(app).post("/api/v1/referrals/link").send({ walletAddress: REFERRER });
    const res2 = await request(app).post("/api/v1/referrals/link").send({ walletAddress: REFERRER });

    expect(res1.body.data.referralCode).toBe(res2.body.data.referralCode);
    expect(mockGenerateReferralLink).toHaveBeenCalledTimes(2);
  });

  test("includes FRONTEND_ORIGIN in referralUrl when env is set", async () => {
    process.env.FRONTEND_ORIGIN = "https://app.example.com";
    mockGenerateReferralLink.mockReturnValue(baseLink());

    const res = await request(app).post("/api/v1/referrals/link").send({ walletAddress: REFERRER });

    expect(res.body.data.referralUrl).toBe(`https://app.example.com/join?ref=${REF_CODE}`);
    delete process.env.FRONTEND_ORIGIN;
  });

  test("400 when walletAddress is missing", async () => {
    const res = await request(app).post("/api/v1/referrals/link").send({});

    expect(res.status).toBe(400);
    expect(mockGenerateReferralLink).not.toHaveBeenCalled();
  });

  test("400 when walletAddress is malformed", async () => {
    const res = await request(app)
      .post("/api/v1/referrals/link")
      .send({ walletAddress: "not-a-stellar-address" });

    expect(res.status).toBe(400);
    expect(mockGenerateReferralLink).not.toHaveBeenCalled();
  });
});

// ─── GET /api/v1/referrals/link/:walletAddress ───────────────────────────────

describe("GET /api/v1/referrals/link/:walletAddress", () => {
  beforeEach(() => jest.clearAllMocks());

  test("returns the referral link for a wallet", async () => {
    mockGetReferralLinkByWallet.mockReturnValue(baseLink());

    const res = await request(app).get(`/api/v1/referrals/link/${REFERRER}`);

    expect(res.status).toBe(200);
    expect(res.body.data.referralCode).toBe(REF_CODE);
    expect(res.body.data.referralUrl).toContain(REF_CODE);
    expect(mockGetReferralLinkByWallet).toHaveBeenCalledWith(REFERRER);
  });

  test("404 when wallet has no referral link yet", async () => {
    mockGetReferralLinkByWallet.mockReturnValue(null);

    const res = await request(app).get(`/api/v1/referrals/link/${REFERRER}`);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("referral_link_not_found");
  });

  test("400 when walletAddress param is invalid", async () => {
    const res = await request(app).get("/api/v1/referrals/link/not-valid");

    expect(res.status).toBe(400);
    expect(mockGetReferralLinkByWallet).not.toHaveBeenCalled();
  });
});

// ─── POST /api/v1/referrals/register ─────────────────────────────────────────

describe("POST /api/v1/referrals/register", () => {
  beforeEach(() => jest.clearAllMocks());

  test("registers a referral and returns 201", async () => {
    mockRegisterReferral.mockReturnValue(baseReferral());

    const res = await request(app)
      .post("/api/v1/referrals/register")
      .send({ referralCode: REF_CODE, referredAddress: REFERRED });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.referrerAddress).toBe(REFERRER);
    expect(res.body.data.status).toBe("pending");
    expect(mockRegisterReferral).toHaveBeenCalledWith({
      referralCode: REF_CODE,
      referredAddress: REFERRED,
    });
  });

  test("404 when referral code does not exist", async () => {
    const err = Object.assign(new Error("Referral code not found"), {
      status: 404,
      code: "referral_code_not_found",
    });
    mockRegisterReferral.mockImplementation(() => { throw err; });

    const res = await request(app)
      .post("/api/v1/referrals/register")
      .send({ referralCode: "REF-000000000000", referredAddress: REFERRED });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("referral_code_not_found");
  });

  test("400 when contributor tries to refer themselves", async () => {
    const err = Object.assign(new Error("A contributor cannot refer themselves"), {
      status: 400,
      code: "self_referral_not_allowed",
    });
    mockRegisterReferral.mockImplementation(() => { throw err; });

    const res = await request(app)
      .post("/api/v1/referrals/register")
      .send({ referralCode: REF_CODE, referredAddress: REFERRER });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("self_referral_not_allowed");
  });

  test("409 when contributor was already referred", async () => {
    const err = Object.assign(new Error("This contributor has already been referred"), {
      status: 409,
      code: "already_referred",
      data: baseReferral(),
    });
    mockRegisterReferral.mockImplementation(() => { throw err; });

    const res = await request(app)
      .post("/api/v1/referrals/register")
      .send({ referralCode: REF_CODE, referredAddress: REFERRED });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("already_referred");
  });

  test("400 when referralCode is missing", async () => {
    const res = await request(app)
      .post("/api/v1/referrals/register")
      .send({ referredAddress: REFERRED });

    expect(res.status).toBe(400);
    expect(mockRegisterReferral).not.toHaveBeenCalled();
  });

  test("400 when referralCode format is invalid", async () => {
    const res = await request(app)
      .post("/api/v1/referrals/register")
      .send({ referralCode: "bad-code", referredAddress: REFERRED });

    expect(res.status).toBe(400);
    expect(mockRegisterReferral).not.toHaveBeenCalled();
  });

  test("400 when referredAddress is malformed", async () => {
    const res = await request(app)
      .post("/api/v1/referrals/register")
      .send({ referralCode: REF_CODE, referredAddress: "not-an-address" });

    expect(res.status).toBe(400);
    expect(mockRegisterReferral).not.toHaveBeenCalled();
  });
});

// ─── GET /api/v1/referrals/dashboard/:walletAddress ──────────────────────────

describe("GET /api/v1/referrals/dashboard/:walletAddress", () => {
  beforeEach(() => jest.clearAllMocks());

  test("returns dashboard stats for a referrer", async () => {
    mockGetReferralDashboard.mockReturnValue(baseDashboard());

    const res = await request(app).get(`/api/v1/referrals/dashboard/${REFERRER}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.totalReferrals).toBe(3);
    expect(res.body.data.activeReferrals).toBe(2);
    expect(res.body.data.pendingReferrals).toBe(1);
    expect(res.body.data.totalBonusStroops).toBe(100_000_000);
    expect(res.body.data.totalBonusXlm).toBe("10.0000000");
    expect(res.body.data.referralCode).toBe(REF_CODE);
    expect(res.body.data.referralUrl).toContain(REF_CODE);
    expect(res.body.data.defaultBonusStroops).toBe(50_000_000);
    expect(mockGetReferralDashboard).toHaveBeenCalledWith(REFERRER, { limit: 50, offset: 0 });
  });

  test("returns zeroed dashboard for a wallet with no referrals", async () => {
    mockGetReferralDashboard.mockReturnValue(
      baseDashboard({ referralCode: null, totalReferrals: 0, activeReferrals: 0,
        pendingReferrals: 0, totalBonusStroops: 0, totalBonusXlm: "0.0000000", referrals: [],
        pagination: { total: 0, limit: 50, offset: 0 } })
    );

    const res = await request(app).get(`/api/v1/referrals/dashboard/${REFERRER}`);

    expect(res.status).toBe(200);
    expect(res.body.data.totalReferrals).toBe(0);
    expect(res.body.data.referralUrl).toBeNull();
  });

  test("respects limit and offset query params", async () => {
    mockGetReferralDashboard.mockReturnValue(baseDashboard());

    await request(app).get(`/api/v1/referrals/dashboard/${REFERRER}?limit=10&offset=5`);

    expect(mockGetReferralDashboard).toHaveBeenCalledWith(REFERRER, { limit: 10, offset: 5 });
  });

  test("400 when walletAddress is invalid", async () => {
    const res = await request(app).get("/api/v1/referrals/dashboard/bad-address");

    expect(res.status).toBe(400);
    expect(mockGetReferralDashboard).not.toHaveBeenCalled();
  });
});

// ─── GET /api/v1/referrals/mine/:walletAddress ───────────────────────────────

describe("GET /api/v1/referrals/mine/:walletAddress", () => {
  beforeEach(() => jest.clearAllMocks());

  test("returns paginated list of referrals for a wallet", async () => {
    mockGetReferralsByReferrer.mockReturnValue([baseReferral(), baseReferral({ id: 2, status: "active" })]);
    mockCountReferralsByReferrer.mockReturnValue(2);

    const res = await request(app).get(`/api/v1/referrals/mine/${REFERRER}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.pagination.total).toBe(2);
    expect(mockGetReferralsByReferrer).toHaveBeenCalledWith(REFERRER, { limit: 50, offset: 0 });
  });

  test("returns empty list when no referrals made", async () => {
    mockGetReferralsByReferrer.mockReturnValue([]);
    mockCountReferralsByReferrer.mockReturnValue(0);

    const res = await request(app).get(`/api/v1/referrals/mine/${REFERRER}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.pagination.total).toBe(0);
  });

  test("400 when walletAddress is invalid", async () => {
    const res = await request(app).get("/api/v1/referrals/mine/not-valid");

    expect(res.status).toBe(400);
    expect(mockGetReferralsByReferrer).not.toHaveBeenCalled();
  });
});

// ─── GET /api/v1/referrals/status/:walletAddress ─────────────────────────────

describe("GET /api/v1/referrals/status/:walletAddress", () => {
  beforeEach(() => jest.clearAllMocks());

  test("returns wasReferred: true and the referral record when found", async () => {
    mockGetReferralByReferred.mockReturnValue(baseReferral());

    const res = await request(app).get(`/api/v1/referrals/status/${REFERRED}`);

    expect(res.status).toBe(200);
    expect(res.body.data.wasReferred).toBe(true);
    expect(res.body.data.referral.referrerAddress).toBe(REFERRER);
    expect(mockGetReferralByReferred).toHaveBeenCalledWith(REFERRED);
  });

  test("returns wasReferred: false with null referral when not referred", async () => {
    mockGetReferralByReferred.mockReturnValue(null);

    const res = await request(app).get(`/api/v1/referrals/status/${REFERRED}`);

    expect(res.status).toBe(200);
    expect(res.body.data.wasReferred).toBe(false);
    expect(res.body.data.referral).toBeNull();
  });

  test("400 when walletAddress is invalid", async () => {
    const res = await request(app).get("/api/v1/referrals/status/bad");

    expect(res.status).toBe(400);
    expect(mockGetReferralByReferred).not.toHaveBeenCalled();
  });
});

// ─── POST /api/v1/referrals/admin/activate ───────────────────────────────────

describe("POST /api/v1/referrals/admin/activate", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ADMIN_ROTATE_TOKEN = ADMIN_TOKEN;
  });

  test("activates a referral and returns the result", async () => {
    mockActivateReferral.mockReturnValue({
      referral: baseReferral({ status: "active", activatedAt: TIMESTAMP }),
      bonus: baseBonus(),
    });

    const res = await request(app)
      .post("/api/v1/referrals/admin/activate")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ referredAddress: REFERRED });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.referral.status).toBe("active");
    expect(res.body.data.bonus.bonusAmountStroops).toBe(50_000_000);
    expect(mockActivateReferral).toHaveBeenCalledWith({
      referredAddress: REFERRED,
      bonusAmountStroops: undefined,
      reason: undefined,
    });
  });

  test("accepts custom bonusAmountStroops and reason", async () => {
    mockActivateReferral.mockReturnValue({
      referral: baseReferral({ status: "active" }),
      bonus: baseBonus({ bonusAmountStroops: 20_000_000, reason: "VIP referral" }),
    });

    const res = await request(app)
      .post("/api/v1/referrals/admin/activate")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ referredAddress: REFERRED, bonusAmountStroops: 20_000_000, reason: "VIP referral" });

    expect(res.status).toBe(200);
    expect(mockActivateReferral).toHaveBeenCalledWith({
      referredAddress: REFERRED,
      bonusAmountStroops: 20_000_000,
      reason: "VIP referral",
    });
  });

  test("is idempotent — returns existing active referral without re-awarding bonus", async () => {
    mockActivateReferral.mockReturnValue({
      referral: baseReferral({ status: "active" }),
      bonus: null,
    });

    const res = await request(app)
      .post("/api/v1/referrals/admin/activate")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ referredAddress: REFERRED });

    expect(res.status).toBe(200);
    expect(res.body.data.bonus).toBeNull();
  });

  test("404 when no referral exists for the referred address", async () => {
    const err = Object.assign(new Error("No referral record found for this contributor"), {
      status: 404,
      code: "referral_not_found",
    });
    mockActivateReferral.mockImplementation(() => { throw err; });

    const res = await request(app)
      .post("/api/v1/referrals/admin/activate")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ referredAddress: REFERRED });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("referral_not_found");
  });

  test("400 when referredAddress is missing", async () => {
    const res = await request(app)
      .post("/api/v1/referrals/admin/activate")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({});

    expect(res.status).toBe(400);
    expect(mockActivateReferral).not.toHaveBeenCalled();
  });

  test("400 when bonusAmountStroops is not a positive integer", async () => {
    const res = await request(app)
      .post("/api/v1/referrals/admin/activate")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ referredAddress: REFERRED, bonusAmountStroops: -100 });

    expect(res.status).toBe(400);
    expect(mockActivateReferral).not.toHaveBeenCalled();
  });

  test("401 without admin token", async () => {
    const res = await request(app)
      .post("/api/v1/referrals/admin/activate")
      .send({ referredAddress: REFERRED });

    expect(res.status).toBe(401);
    expect(mockActivateReferral).not.toHaveBeenCalled();
  });

  test("401 with wrong admin token", async () => {
    const res = await request(app)
      .post("/api/v1/referrals/admin/activate")
      .set("Authorization", "Bearer wrong-token")
      .send({ referredAddress: REFERRED });

    expect(res.status).toBe(401);
  });
});

// ─── POST /api/v1/referrals/admin/bonus ──────────────────────────────────────

describe("POST /api/v1/referrals/admin/bonus", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ADMIN_ROTATE_TOKEN = ADMIN_TOKEN;
  });

  test("manually awards a bonus and returns 201", async () => {
    mockAwardReferralBonus.mockReturnValue(
      baseBonus({ bonusAmountStroops: 10_000_000, reason: "Bonus referral milestone" })
    );

    const res = await request(app)
      .post("/api/v1/referrals/admin/bonus")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({
        referralId: 1,
        referrerAddress: REFERRER,
        bonusAmountStroops: 10_000_000,
        reason: "Bonus referral milestone",
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.bonusAmountStroops).toBe(10_000_000);
    expect(res.body.data.reason).toBe("Bonus referral milestone");
    expect(mockAwardReferralBonus).toHaveBeenCalledWith({
      referralId: 1,
      referrerAddress: REFERRER,
      bonusAmountStroops: 10_000_000,
      reason: "Bonus referral milestone",
    });
  });

  test("400 when referralId is missing", async () => {
    const res = await request(app)
      .post("/api/v1/referrals/admin/bonus")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ referrerAddress: REFERRER, bonusAmountStroops: 10_000_000, reason: "Test bonus" });

    expect(res.status).toBe(400);
    expect(mockAwardReferralBonus).not.toHaveBeenCalled();
  });

  test("400 when referrerAddress is malformed", async () => {
    const res = await request(app)
      .post("/api/v1/referrals/admin/bonus")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ referralId: 1, referrerAddress: "bad", bonusAmountStroops: 10_000_000, reason: "Test" });

    expect(res.status).toBe(400);
    expect(mockAwardReferralBonus).not.toHaveBeenCalled();
  });

  test("400 when bonusAmountStroops is zero", async () => {
    const res = await request(app)
      .post("/api/v1/referrals/admin/bonus")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ referralId: 1, referrerAddress: REFERRER, bonusAmountStroops: 0, reason: "Test" });

    expect(res.status).toBe(400);
    expect(mockAwardReferralBonus).not.toHaveBeenCalled();
  });

  test("400 when reason is empty", async () => {
    const res = await request(app)
      .post("/api/v1/referrals/admin/bonus")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ referralId: 1, referrerAddress: REFERRER, bonusAmountStroops: 10_000_000, reason: "" });

    expect(res.status).toBe(400);
    expect(mockAwardReferralBonus).not.toHaveBeenCalled();
  });

  test("401 without admin token", async () => {
    const res = await request(app)
      .post("/api/v1/referrals/admin/bonus")
      .send({ referralId: 1, referrerAddress: REFERRER, bonusAmountStroops: 10_000_000, reason: "Test" });

    expect(res.status).toBe(401);
    expect(mockAwardReferralBonus).not.toHaveBeenCalled();
  });
});

// ─── GET /api/v1/referrals/admin/all ─────────────────────────────────────────

describe("GET /api/v1/referrals/admin/all", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ADMIN_ROTATE_TOKEN = ADMIN_TOKEN;
  });

  test("returns paginated list of all referrals", async () => {
    mockGetAllReferrals.mockReturnValue([
      baseReferral(),
      baseReferral({ id: 2, status: "active", referredAddress: "GDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD" }),
    ]);
    mockCountAllReferrals.mockReturnValue(2);

    const res = await request(app)
      .get("/api/v1/referrals/admin/all")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.pagination.total).toBe(2);
    expect(mockGetAllReferrals).toHaveBeenCalledWith({ limit: 50, offset: 0 });
  });

  test("filters by status=pending", async () => {
    mockGetAllReferrals.mockReturnValue([baseReferral()]);
    mockCountAllReferrals.mockReturnValue(1);

    const res = await request(app)
      .get("/api/v1/referrals/admin/all?status=pending")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`);

    expect(res.status).toBe(200);
    expect(mockGetAllReferrals).toHaveBeenCalledWith({ status: "pending", limit: 50, offset: 0 });
  });

  test("filters by status=active", async () => {
    mockGetAllReferrals.mockReturnValue([baseReferral({ status: "active" })]);
    mockCountAllReferrals.mockReturnValue(1);

    const res = await request(app)
      .get("/api/v1/referrals/admin/all?status=active")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`);

    expect(res.status).toBe(200);
    expect(mockGetAllReferrals).toHaveBeenCalledWith({ status: "active", limit: 50, offset: 0 });
  });

  test("filters by status=bonus_paid", async () => {
    mockGetAllReferrals.mockReturnValue([]);
    mockCountAllReferrals.mockReturnValue(0);

    const res = await request(app)
      .get("/api/v1/referrals/admin/all?status=bonus_paid")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`);

    expect(res.status).toBe(200);
    expect(mockGetAllReferrals).toHaveBeenCalledWith({ status: "bonus_paid", limit: 50, offset: 0 });
  });

  test("400 when status filter is invalid", async () => {
    const res = await request(app)
      .get("/api/v1/referrals/admin/all?status=nonsense")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_status");
    expect(mockGetAllReferrals).not.toHaveBeenCalled();
  });

  test("respects limit and offset params", async () => {
    mockGetAllReferrals.mockReturnValue([]);
    mockCountAllReferrals.mockReturnValue(0);

    await request(app)
      .get("/api/v1/referrals/admin/all?limit=5&offset=10")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`);

    expect(mockGetAllReferrals).toHaveBeenCalledWith({ limit: 5, offset: 10 });
  });

  test("401 without admin token", async () => {
    const res = await request(app).get("/api/v1/referrals/admin/all");

    expect(res.status).toBe(401);
    expect(mockGetAllReferrals).not.toHaveBeenCalled();
  });

  test("401 with wrong admin token", async () => {
    const res = await request(app)
      .get("/api/v1/referrals/admin/all")
      .set("Authorization", "Bearer bad-token");

    expect(res.status).toBe(401);
  });
});

// ─── Bonus calculation correctness ───────────────────────────────────────────

describe("Bonus calculation", () => {
  test("DEFAULT_REFERRAL_BONUS_STROOPS equals 5 XLM (50,000,000 stroops)", async () => {
    const { DEFAULT_REFERRAL_BONUS_STROOPS } = await import("../src/database/referrals.js");
    expect(DEFAULT_REFERRAL_BONUS_STROOPS).toBe(50_000_000);
  });

  test("dashboard totalBonusXlm correctly converts stroops to XLM", () => {
    mockGetReferralDashboard.mockReturnValue(
      baseDashboard({ totalBonusStroops: 150_000_000, totalBonusXlm: "15.0000000" })
    );
    return request(app)
      .get(`/api/v1/referrals/dashboard/${REFERRER}`)
      .then((res) => {
        expect(res.body.data.totalBonusXlm).toBe("15.0000000");
        expect(res.body.data.totalBonusStroops).toBe(150_000_000);
      });
  });

  test("dashboard includes defaultBonusXlm derived from DEFAULT_REFERRAL_BONUS_STROOPS", () => {
    mockGetReferralDashboard.mockReturnValue(baseDashboard());
    return request(app)
      .get(`/api/v1/referrals/dashboard/${REFERRER}`)
      .then((res) => {
        // Mock exported 50_000_000 stroops → 5.0000000 XLM
        expect(res.body.data.defaultBonusXlm).toBe("5.0000000");
      });
  });
});

// ─── Full referral lifecycle integration ─────────────────────────────────────

describe("Full referral lifecycle (generate → register → activate)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ADMIN_ROTATE_TOKEN = ADMIN_TOKEN;
  });

  test("complete lifecycle from link generation through bonus award", async () => {
    // 1. Referrer generates a link
    mockGenerateReferralLink.mockReturnValue(baseLink());
    const linkRes = await request(app)
      .post("/api/v1/referrals/link")
      .send({ walletAddress: REFERRER });
    expect(linkRes.status).toBe(201);
    const { referralCode } = linkRes.body.data;

    // 2. New contributor signs up via the link
    mockRegisterReferral.mockReturnValue(baseReferral());
    const registerRes = await request(app)
      .post("/api/v1/referrals/register")
      .send({ referralCode, referredAddress: REFERRED });
    expect(registerRes.status).toBe(201);
    expect(registerRes.body.data.status).toBe("pending");

    // 3. Referred contributor checks their referral status
    mockGetReferralByReferred.mockReturnValue(baseReferral());
    const statusRes = await request(app).get(`/api/v1/referrals/status/${REFERRED}`);
    expect(statusRes.status).toBe(200);
    expect(statusRes.body.data.wasReferred).toBe(true);
    expect(statusRes.body.data.referral.referrerAddress).toBe(REFERRER);

    // 4. Admin activates the referral after first qualifying distribution
    mockActivateReferral.mockReturnValue({
      referral: baseReferral({ status: "active", activatedAt: TIMESTAMP }),
      bonus: baseBonus(),
    });
    const activateRes = await request(app)
      .post("/api/v1/referrals/admin/activate")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ referredAddress: REFERRED });
    expect(activateRes.status).toBe(200);
    expect(activateRes.body.data.referral.status).toBe("active");
    expect(activateRes.body.data.bonus.bonusAmountStroops).toBe(50_000_000);

    // 5. Referrer views their updated dashboard
    mockGetReferralDashboard.mockReturnValue(
      baseDashboard({ activeReferrals: 1, pendingReferrals: 0,
        totalBonusStroops: 50_000_000, totalBonusXlm: "5.0000000" })
    );
    const dashRes = await request(app).get(`/api/v1/referrals/dashboard/${REFERRER}`);
    expect(dashRes.status).toBe(200);
    expect(dashRes.body.data.activeReferrals).toBe(1);
    expect(dashRes.body.data.totalBonusXlm).toBe("5.0000000");
  });

  test("multiple referrals accumulate bonus correctly in dashboard", async () => {
    mockGetReferralDashboard.mockReturnValue(
      baseDashboard({
        totalReferrals: 5,
        activeReferrals: 4,
        pendingReferrals: 1,
        totalBonusStroops: 200_000_000,
        totalBonusXlm: "20.0000000",
      })
    );

    const res = await request(app).get(`/api/v1/referrals/dashboard/${REFERRER}`);
    expect(res.status).toBe(200);
    expect(res.body.data.totalReferrals).toBe(5);
    expect(res.body.data.totalBonusStroops).toBe(200_000_000);
    expect(res.body.data.totalBonusXlm).toBe("20.0000000");
  });
});
