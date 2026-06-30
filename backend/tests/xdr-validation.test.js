import { jest, describe, test, expect, beforeEach } from "@jest/globals";

const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";

function createMockTransaction(overrides = {}) {
  const defaults = {
    source: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    fee: "250",
    sequence: "123456789",
    operations: [{ type: "operation", op: {} }],
    timeBounds: { minTime: "0", maxTime: "30" },
  };
  const merged = { ...defaults, ...overrides };
  merged.fee = String(merged.fee);
  return merged;
}

function makeSdkMock(cfg) {
  const mockTransaction = cfg.throws
    ? { __proto__: Error.prototype, constructor: Error, message: cfg.throws }
    : createMockTransaction(cfg);

  const sdkMock = {
    default: {
      xdr: {},
      Transaction: jest.fn(() => {
        if (cfg.throws) throw new Error(cfg.throws);
        return mockTransaction;
      }),
    },
    Transaction: jest.fn(() => {
      if (cfg.throws) throw new Error(cfg.throws);
      return mockTransaction;
    }),
    xdr: {},
  };
  return sdkMock;
}

describe("validateXdrStructure", () => {
  beforeEach(() => {
    jest.resetModules();
  });

  test("accepts a valid XDR string", async () => {
    const sdkMock = makeSdkMock({});
    await jest.unstable_mockModule("@stellar/stellar-sdk", () => sdkMock);

    const { validateXdrStructure } = await import("../src/xdr-validation.js");

    const result = validateXdrStructure("valid-xdr", NETWORK_PASSPHRASE);
    expect(result.valid).toBe(true);
    expect(result.errors).toBeUndefined();
  });

  test("rejects a malformed XDR string", async () => {
    const sdkMock = makeSdkMock({ throws: "Unexpected XDR node" });
    await jest.unstable_mockModule("@stellar/stellar-sdk", () => sdkMock);

    const { validateXdrStructure } = await import("../src/xdr-validation.js");

    const result = validateXdrStructure("bad-xdr", NETWORK_PASSPHRASE);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/Invalid XDR/);
  });

  test("rejects XDR with fee below minimum", async () => {
    const sdkMock = makeSdkMock({ fee: 50 });
    await jest.unstable_mockModule("@stellar/stellar-sdk", () => sdkMock);

    const { validateXdrStructure } = await import("../src/xdr-validation.js");

    const result = validateXdrStructure("low-fee-xdr", NETWORK_PASSPHRASE);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("Fee too low"))).toBe(true);
  });

  test("rejects XDR with fee above maximum", async () => {
    const sdkMock = makeSdkMock({ fee: 200_000 });
    await jest.unstable_mockModule("@stellar/stellar-sdk", () => sdkMock);

    const { validateXdrStructure } = await import("../src/xdr-validation.js");

    const result = validateXdrStructure("high-fee-xdr", NETWORK_PASSPHRASE);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("Fee too high"))).toBe(true);
  });

  test("rejects XDR with no operations", async () => {
    const sdkMock = makeSdkMock({ operations: [] });
    await jest.unstable_mockModule("@stellar/stellar-sdk", () => sdkMock);

    const { validateXdrStructure } = await import("../src/xdr-validation.js");

    const result = validateXdrStructure("no-ops-xdr", NETWORK_PASSPHRASE);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("at least one operation"))).toBe(true);
  });

  test("rejects XDR with invalid source account", async () => {
    const sdkMock = makeSdkMock({ source: "INVALID_ACCOUNT" });
    await jest.unstable_mockModule("@stellar/stellar-sdk", () => sdkMock);

    const { validateXdrStructure } = await import("../src/xdr-validation.js");

    const result = validateXdrStructure("bad-source-xdr", NETWORK_PASSPHRASE);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("Invalid source"))).toBe(true);
  });

  test("rejects XDR with no time bounds", async () => {
    const sdkMock = makeSdkMock({ timeBounds: null });
    await jest.unstable_mockModule("@stellar/stellar-sdk", () => sdkMock);

    const { validateXdrStructure } = await import("../src/xdr-validation.js");

    const result = validateXdrStructure("no-tb-xdr", NETWORK_PASSPHRASE);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("time bounds"))).toBe(true);
  });

  test("collects multiple validation errors at once", async () => {
    const sdkMock = makeSdkMock({
      source: null,
      fee: 10,
      operations: [],
      timeBounds: undefined,
    });
    await jest.unstable_mockModule("@stellar/stellar-sdk", () => sdkMock);

    const { validateXdrStructure } = await import("../src/xdr-validation.js");

    const result = validateXdrStructure("bad-xdr", NETWORK_PASSPHRASE);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(4);
  });
});

describe("buildAndRecordTransaction XDR validation integration", () => {
  beforeEach(() => {
    jest.resetModules();
  });

  test("throws when retryBuildTx returns invalid XDR", async () => {
    const retryBuildTx = jest.fn().mockResolvedValue("invalid-xdr");

    await jest.unstable_mockModule("../src/stellar.js", () => ({
      retryBuildTx,
      networkPassphrase: NETWORK_PASSPHRASE,
    }));

    const sdkMock = makeSdkMock({ throws: "corrupt envelope" });
    await jest.unstable_mockModule("@stellar/stellar-sdk", () => sdkMock);

    await jest.unstable_mockModule("../src/database/index.js", () => ({
      recordTransaction: jest.fn(() => "tx-999"),
      addAuditLog: jest.fn(),
    }));

    const { buildAndRecordTransaction } = await import("../src/routes/_shared.js");

    await expect(
      buildAndRecordTransaction({
        contractId: "CCONTRACT",
        walletAddress: "GWALLET",
        transactionType: "test",
        scvlArgs: [],
        auditAction: "test",
        auditMetadata: {},
      })
    ).rejects.toMatchObject({
      status: 500,
      code: "xdr_validation_error",
    });
  });
});
