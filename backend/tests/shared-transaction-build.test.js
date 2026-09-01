/**
 * Tests for the shared transaction-build handler used by POST /api/distribute
 * (backend/src/routes/distribute.js → routes/_shared.js).
 *
 * Regression coverage: the XDR must be built EXACTLY ONCE per request.
 * A previous revision invoked `retryBuildTx` twice, discarding the first
 * result and needlessly consuming a fresh sequence number per request.
 * Transient RPC failures are still retried — but inside `retryBuildTx`.
 */

import { jest, describe, test, expect, beforeEach } from "@jest/globals";

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

const mockRetryBuildTx = jest.fn();
const mockRecordTransaction = jest.fn(() => 42);
const mockAddAuditLog = jest.fn();
const mockStartTracking = jest.fn();

await jest.unstable_mockModule("../src/logger.js", () => ({
  default: mockLogger,
}));

await jest.unstable_mockModule("../src/stellar.js", () => ({
  retryBuildTx: mockRetryBuildTx,
}));

await jest.unstable_mockModule("../src/database/index.js", () => ({
  recordTransaction: mockRecordTransaction,
  addAuditLog: mockAddAuditLog,
}));

await jest.unstable_mockModule("../src/tracing.js", () => ({
  startSpan: jest.fn(async (_name, _attrs, fn) => fn()),
}));

await jest.unstable_mockModule("../src/transaction-finality.js", () => ({
  startTracking: mockStartTracking,
}));

const { buildAndRecordTransaction } = await import("../src/routes/_shared.js");

const INPUT = {
  contractId: "C11111111111111111111111111111111111111111111111111111111",
  walletAddress: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
  transactionType: "distribute",
  scvlArgs: ["arg1", "arg2"],
  auditAction: "distribution_initiated",
  auditMetadata: { tokenId: "TOK1" },
  transactionMetadata: { tokenId: "TOK1" },
};

describe("buildAndRecordTransaction", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRetryBuildTx.mockResolvedValue("unsigned-xdr");
    mockRecordTransaction.mockReturnValue(42);
  });

  test("builds the transaction XDR exactly once", async () => {
    await buildAndRecordTransaction(INPUT);

    expect(mockRetryBuildTx).toHaveBeenCalledTimes(1);
    expect(mockRetryBuildTx).toHaveBeenCalledWith(
      INPUT.walletAddress,
      INPUT.contractId,
      INPUT.transactionType,
      INPUT.scvlArgs
    );
  });

  test("returns the single built XDR together with the recorded transaction id", async () => {
    const result = await buildAndRecordTransaction(INPUT);

    expect(result).toEqual({ xdr: "unsigned-xdr", transactionId: 42 });
  });

  test("records the transaction and audit log with the returned transaction id", async () => {
    await buildAndRecordTransaction(INPUT);

    expect(mockRecordTransaction).toHaveBeenCalledTimes(1);
    expect(mockRecordTransaction).toHaveBeenCalledWith(
      INPUT.contractId,
      INPUT.transactionType,
      INPUT.walletAddress,
      INPUT.transactionMetadata
    );
    expect(mockAddAuditLog).toHaveBeenCalledTimes(1);
    expect(mockAddAuditLog).toHaveBeenCalledWith(INPUT.contractId, INPUT.auditAction, INPUT.walletAddress, {
      transactionId: 42,
      ...INPUT.auditMetadata,
    });
  });

  test("starts best-effort finality tracking with a null tx hash", async () => {
    await buildAndRecordTransaction(INPUT);

    expect(mockStartTracking).toHaveBeenCalledTimes(1);
    expect(mockStartTracking).toHaveBeenCalledWith({ transactionId: 42, txHash: null });
  });

  test("does not record the transaction when the build fails", async () => {
    mockRetryBuildTx.mockRejectedValue({ status: 504, message: "Soroban RPC timed out" });

    await expect(buildAndRecordTransaction(INPUT)).rejects.toEqual({
      status: 504,
      message: "Soroban RPC timed out",
    });

    expect(mockRecordTransaction).not.toHaveBeenCalled();
    expect(mockAddAuditLog).not.toHaveBeenCalled();
    expect(mockStartTracking).not.toHaveBeenCalled();
  });

  test("build failure does not start finality tracking", async () => {
    mockRetryBuildTx.mockRejectedValue({ status: 503, message: "unavailable" });

    await expect(buildAndRecordTransaction(INPUT)).rejects.toEqual({
      status: 503,
      message: "unavailable",
    });

    expect(mockStartTracking).not.toHaveBeenCalled();
  });
});
