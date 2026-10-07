import { jest, describe, test, expect, beforeEach } from "@jest/globals";

const recordEmission = jest.fn(() => 1);
const getUserEmissions = jest.fn(() => ({ txCount: 0, totalGrams: 0 }));
const getUserEmissionsByDay = jest.fn(() => []);
const getProjectEmissions = jest.fn(() => ({ txCount: 0, totalGrams: 0, contributorCount: 0 }));
const getProjectEmissionsByDay = jest.fn(() => []);
const recordOffset = jest.fn(() => 5);
const getUserOffsets = jest.fn(() => ({ purchaseCount: 0, totalTonnes: 0, totalUsdCents: 0 }));
const listUserOffsets = jest.fn(() => []);
const countUserOffsets = jest.fn(() => 0);
const getProjectOffsets = jest.fn(() => ({ purchaseCount: 0, totalTonnes: 0, contributorCount: 0 }));
const getCarbonSettings = jest.fn(() => ({
  walletAddress: "GAAA",
  autoOffsetEnabled: false,
  offsetPercentage: 1.0,
}));
const upsertCarbonSettings = jest.fn((wallet) => ({
  walletAddress: wallet,
  autoOffsetEnabled: true,
  offsetPercentage: 2.5,
}));
const listAutoOffsetWallets = jest.fn(() => []);

await jest.unstable_mockModule("../src/database/carbon.js", () => ({
  recordEmission,
  getUserEmissions,
  getUserEmissionsByDay,
  getProjectEmissions,
  getProjectEmissionsByDay,
  recordOffset,
  getUserOffsets,
  listUserOffsets,
  countUserOffsets,
  getProjectOffsets,
  getCarbonSettings,
  upsertCarbonSettings,
  listAutoOffsetWallets,
}));

await jest.unstable_mockModule("../src/logger.js", () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const {
  estimateTxFootprintGrams,
  gramsToTonnes,
  tonnesToUsdCents,
  recordTransactionFootprint,
  getUserFootprint,
  getProjectFootprint,
  purchaseOffsets,
  saveAutoOffsetSettings,
  buildSharePayload,
  OFFSET_PROJECTS,
  isSupportedProject,
  _carbonConfig,
} = await import("../src/services/carbon-tracker.js");

describe("carbon-tracker (#1064)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    recordEmission.mockReturnValue(1);
    getUserEmissions.mockReturnValue({ txCount: 0, totalGrams: 0 });
    getUserEmissionsByDay.mockReturnValue([]);
    getProjectEmissions.mockReturnValue({ txCount: 0, totalGrams: 0, contributorCount: 0 });
    getProjectEmissionsByDay.mockReturnValue([]);
    recordOffset.mockReturnValue(5);
    getUserOffsets.mockReturnValue({ purchaseCount: 0, totalTonnes: 0, totalUsdCents: 0 });
    listUserOffsets.mockReturnValue([]);
    countUserOffsets.mockReturnValue(0);
    getProjectOffsets.mockReturnValue({ purchaseCount: 0, totalTonnes: 0, contributorCount: 0 });
    listAutoOffsetWallets.mockReturnValue([]);
  });

  test("estimates a positive per-transaction footprint that scales with operations", () => {
    const single = estimateTxFootprintGrams({ operationCount: 1 });
    expect(single).toBeGreaterThan(0);
    expect(estimateTxFootprintGrams({ operationCount: 4 })).toBeCloseTo(single * 4, 10);
    expect(estimateTxFootprintGrams()).toBe(single);
    expect(estimateTxFootprintGrams({ operationCount: 0 })).toBe(single);
  });

  test("exposes methodology constants", () => {
    expect(_carbonConfig.CARBON_WH_PER_TX).toBeGreaterThan(0);
    expect(_carbonConfig.CARBON_GCO2_PER_KWH).toBeGreaterThan(0);
    expect(_carbonConfig.CARBON_OFFSET_USD_PER_TONNE).toBeGreaterThan(0);
  });

  test("unit conversions are consistent", () => {
    expect(gramsToTonnes(1_000_000)).toBe(1);
    expect(tonnesToUsdCents(1, 15)).toBe(1500);
  });

  test("recordTransactionFootprint persists and returns grams", () => {
    const result = recordTransactionFootprint({
      contractId: "CAAA",
      walletAddress: "GAAA",
      txHash: "a".repeat(64),
      operationCount: 2,
    });

    expect(recordEmission).toHaveBeenCalledWith(
      expect.objectContaining({ walletAddress: "GAAA", operationCount: 2 })
    );
    expect(result.emissionId).toBe(1);
    expect(result.gramsCo2).toBeCloseTo(estimateTxFootprintGrams({ operationCount: 2 }), 10);
  });

  test("recordTransactionFootprint requires contract and wallet", () => {
    expect(() => recordTransactionFootprint({ contractId: null, walletAddress: "GAAA" })).toThrow();
    expect(recordEmission).not.toHaveBeenCalled();
  });

  test("getUserFootprint combines emissions, offsets, and coverage", () => {
    getUserEmissions.mockReturnValue({ txCount: 10, totalGrams: 1000 });
    getUserEmissionsByDay.mockReturnValue([{ date: "2026-01-01", txCount: 10, grams: 1000 }]);
    getUserOffsets.mockReturnValue({ purchaseCount: 1, totalTonnes: 0.00025, totalUsdCents: 1 });

    const footprint = getUserFootprint("GAAA");

    expect(footprint).toMatchObject({ txCount: 10, totalGrams: 1000, totalKg: 1 });
    expect(footprint.offsetGrams).toBeCloseTo(250, 6);
    expect(footprint.netGrams).toBeCloseTo(750, 6);
    expect(footprint.offsetCoveragePercent).toBeCloseTo(25, 6);
    expect(footprint.byDay).toHaveLength(1);
  });

  test("getUserFootprint reports full coverage when nothing was emitted", () => {
    expect(getUserFootprint("GAAA").offsetCoveragePercent).toBe(100);
  });

  test("getProjectFootprint aggregates project impact", () => {
    getProjectEmissions.mockReturnValue({ txCount: 7, totalGrams: 700, contributorCount: 3 });

    const project = getProjectFootprint("CAAA");

    expect(project).toMatchObject({ txCount: 7, totalKg: 0.7, contributorCount: 3 });
  });

  test("purchaseOffsets by tonnes prices from the offset rate", () => {
    const result = purchaseOffsets({ walletAddress: "GAAA", tonnes: 0.01, project: "forest" });

    expect(recordOffset).toHaveBeenCalledWith(
      expect.objectContaining({ tonnes: 0.01, project: "forest", status: "completed" })
    );
    expect(result).toMatchObject({ offsetId: 5, status: "completed" });
    expect(result.amountUsdCents).toBe(tonnesToUsdCents(0.01));
  });

  test("purchaseOffsets by USD amount derives tonnes", () => {
    const result = purchaseOffsets({ walletAddress: "GAAA", amountUsdCents: 1500 });

    expect(result.tonnes).toBeCloseTo(1, 10);
    expect(result.amountUsdCents).toBe(1500);
  });

  test("purchaseOffsets rejects bad input", () => {
    expect(() => purchaseOffsets({ walletAddress: "GAAA" })).toThrow("Provide tonnes");
    expect(() => purchaseOffsets({ walletAddress: "GAAA", tonnes: -1 })).toThrow();
    expect(() =>
      purchaseOffsets({ walletAddress: "GAAA", tonnes: 1, project: "bogus" })
    ).toThrow("Unsupported offset project");
    expect(recordOffset).not.toHaveBeenCalled();
  });

  test("non-demo providers record pending purchases", () => {
    const result = purchaseOffsets({ walletAddress: "GAAA", tonnes: 1, provider: "stripe-climate" });
    expect(result.status).toBe("pending");
  });

  test("offset project catalog covers forest and ocean", () => {
    expect(OFFSET_PROJECTS.length).toBeGreaterThan(0);
    const types = new Set(OFFSET_PROJECTS.map((p) => p.type));
    expect(types.has("forest")).toBe(true);
    expect(types.has("ocean")).toBe(true);
    expect(isSupportedProject("forest")).toBe(true);
    expect(isSupportedProject("pacific-blue-carbon")).toBe(true);
    expect(isSupportedProject("bogus")).toBe(false);
  });

  test("saveAutoOffsetSettings validates and persists", () => {
    const saved = saveAutoOffsetSettings("GAAA", { autoOffsetEnabled: true, offsetPercentage: 2.5 });
    expect(upsertCarbonSettings).toHaveBeenCalledWith("GAAA", {
      autoOffsetEnabled: true,
      offsetPercentage: 2.5,
    });
    expect(saved.offsetPercentage).toBe(2.5);

    expect(() =>
      saveAutoOffsetSettings("GAAA", { autoOffsetEnabled: "yes", offsetPercentage: 1 })
    ).toThrow();
    expect(() =>
      saveAutoOffsetSettings("GAAA", { autoOffsetEnabled: true, offsetPercentage: 101 })
    ).toThrow();
  });

  test("buildSharePayload returns text and per-network URLs", () => {
    getUserEmissions.mockReturnValue({ txCount: 4, totalGrams: 400 });

    const share = buildSharePayload("GAAA");

    expect(share.text).toMatch("0.400 kg CO2");
    expect(share.text).toMatch("4 transactions");
    expect(share.shareUrls.x).toMatch("twitter.com/intent/tweet");
    expect(share.shareUrls.facebook).toMatch("facebook.com/sharer");
    expect(share.shareUrls.linkedin).toMatch("linkedin.com/sharing");
  });

  test("runAutoOffset is a no-op without opted-in recipients", async () => {
    const { runAutoOffset } = await import("../src/services/carbon-tracker.js");
    const result = await runAutoOffset({
      contractId: "CAAA",
      payouts: [{ address: "GAAA", amountStroops: "10000000" }],
    });
    expect(result).toEqual({ attempted: 0, purchased: 0, skipped: 0, tonnes: 0 });
    expect(recordOffset).not.toHaveBeenCalled();
  });
});
