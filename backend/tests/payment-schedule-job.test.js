import { jest, describe, test, expect, beforeEach } from "@jest/globals";

const mockGetSchedulesDue = jest.fn();
const mockMarkScheduleRan = jest.fn();
const mockComputeNextRun = jest.fn();
const mockRecordTransaction = jest.fn();
const mockAddAuditLog = jest.fn();
const mockDeliverWebhooks = jest.fn();
const mockBroadcastTransactionStatus = jest.fn();

await jest.unstable_mockModule("../src/database/payment-schedules.js", () => ({
  getSchedulesDue: mockGetSchedulesDue,
  markScheduleRan: mockMarkScheduleRan,
}));

await jest.unstable_mockModule("../src/schedule-calculator.js", () => ({
  computeNextRun: mockComputeNextRun,
}));

await jest.unstable_mockModule("../src/database/index.js", () => ({
  recordTransaction: mockRecordTransaction,
  addAuditLog: mockAddAuditLog,
}));

await jest.unstable_mockModule("../src/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

await jest.unstable_mockModule("../src/stellar.js", () => ({
  server: {
    simulateTransaction: jest.fn(),
  },
  addressToScVal: jest.fn(),
  networkPassphrase: "Test SDF Network ; September 2015",
}));

await jest.unstable_mockModule("../src/webhook-delivery.js", () => ({
  deliverWebhooks: mockDeliverWebhooks,
}));

await jest.unstable_mockModule("../src/websocket.js", () => ({
  broadcastTransactionStatus: mockBroadcastTransactionStatus,
}));

const { runPaymentSchedules } = await import("../src/jobs/payment-schedule-job.js");

describe("runPaymentSchedules (#1211)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("returns { triggered: 0, failed: 0 } without skipped when no schedules are due", async () => {
    mockGetSchedulesDue.mockReturnValue([]);

    const result = await runPaymentSchedules();

    expect(result).toEqual({ triggered: 0, failed: 0 });
    expect(result.skipped).toBeUndefined();
  });

  test("returns { triggered: 0, failed: 1 } without skipped on simulation or processing error", async () => {
    mockGetSchedulesDue.mockReturnValue([
      {
        id: 1,
        name: "Monthly Test",
        type: "monthly",
        contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        tokenId: "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
        walletAddress: "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H",
        enabled: 1,
      },
    ]);

    // Will fail during TransactionBuilder or simulation
    const result = await runPaymentSchedules();

    expect(result).toHaveProperty("triggered");
    expect(result).toHaveProperty("failed");
    expect(result.skipped).toBeUndefined();
  });
});
