/**
 * Tests for the contract snapshot job (#1237, #1240).
 */
import { jest, describe, test, expect, beforeEach } from "@jest/globals";

const CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const ALICE = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const BOB = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

const mockGet = jest.fn();
const mockAll = jest.fn();
const mockPrepare = jest.fn(() => ({ get: mockGet, all: mockAll }));

const mockCreateSnapshot = jest.fn();
const mockPruneSnapshots = jest.fn(() => 0);

await jest.unstable_mockModule("../src/database/index.js", () => ({
  default: { prepare: mockPrepare },
}));

await jest.unstable_mockModule("../src/database/contract-snapshots.js", () => ({
  createSnapshot: mockCreateSnapshot,
  ensureSnapshotTable: jest.fn(),
  pruneSnapshots: mockPruneSnapshots,
}));

const { computeContractState, executeSnapshotRun } = await import("../src/jobs/snapshot-job.js");

// computeContractState queries, in order:
//   .all() → distinct collaborators
//   .get() → transaction count
//   .get() → last transaction
//   .all() → cumulative payouts per collaborator
function mockContractRows() {
  mockAll
    .mockReturnValueOnce([{ collaboratorAddress: ALICE }, { collaboratorAddress: BOB }])
    .mockReturnValueOnce([
      { collaboratorAddress: ALICE, totalReceived: 75.123 },
      { collaboratorAddress: BOB, totalReceived: 25 },
    ]);
  mockGet.mockReturnValueOnce({ cnt: 3 }).mockReturnValueOnce({ id: 7 });
}

describe("computeContractState", () => {
  beforeEach(() => jest.clearAllMocks());

  test("does not store payout totals as shares", () => {
    mockContractRows();
    const state = computeContractState(CONTRACT);

    expect(JSON.parse(state.shares)).toBeNull();
    expect(state.sharesSource).toBe("unavailable");
    expect(JSON.parse(state.balances)).toEqual({ [ALICE]: 75.12, [BOB]: 25 });
    expect(JSON.parse(state.collaborators)).toEqual([ALICE, BOB]);
    expect(state.collaboratorsSource).toBe("distribution_payouts");
    expect(state.transactionCount).toBe(3);
    expect(state.lastTransactionId).toBe(7);
  });

  test("falls back to audit_log when no distributions exist", () => {
    // Query order:
    // 1. distribution_payouts (empty)
    // 2. audit_log (with collaborators)
    // 3. transaction count
    // 4. last transaction
    // 5. balances (empty)
    mockAll
      .mockReturnValueOnce([]) // No distribution_payouts
      .mockReturnValueOnce([{ details: JSON.stringify({ collaborators: [{ address: ALICE }, { address: BOB }] }) }]) // audit_log
      .mockReturnValueOnce([]); // No balances
    mockGet.mockReturnValueOnce({ cnt: 1 }).mockReturnValueOnce({ id: 5 });

    const state = computeContractState(CONTRACT);

    expect(JSON.parse(state.collaborators)).toEqual([ALICE, BOB]);
    expect(state.collaboratorsSource).toBe("audit_log");
    expect(state.transactionCount).toBe(1);
    expect(state.lastTransactionId).toBe(5);
  });
});

describe("executeSnapshotRun", () => {
  beforeEach(() => jest.clearAllMocks());

  test("snapshots and prunes each active contract", async () => {
    mockAll.mockReturnValueOnce([{ contractId: CONTRACT }]);
    mockContractRows();
    mockPruneSnapshots.mockReturnValueOnce(2);

    const result = await executeSnapshotRun({ forceLabel: "manual" });

    expect(result).toEqual({ snapshotsCreated: 1, contractsProcessed: 1, errors: [] });
    expect(mockCreateSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ contractId: CONTRACT, label: "manual", shares: "null" })
    );
    expect(mockPruneSnapshots).toHaveBeenCalledWith(CONTRACT, 90);
  });
});
