/**
 * Tests for contract backup and disaster recovery (#993).
 *
 * Three suites:
 *  1. contract-backup unit tests   — buildSnapshot, uploadToIpfs, takeSnapshot, runBackupJob
 *  2. disaster-recovery unit tests — validateSnapshot, buildRecoveryBundle, runRecoveryDrill
 *  3. Route integration tests      — HTTP layer via supertest
 */

import { jest, describe, test, expect, beforeEach } from "@jest/globals";
import request from "supertest";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const MOCK_SNAPSHOT = {
  version: 1,
  contractId: CONTRACT,
  snapshotAt: "2026-09-28T09:00:00.000Z",
  transactions: [
    { id: 1, contractId: CONTRACT, type: "distribute", status: "confirmed" },
  ],
  distributionPayouts: [
    { id: 1, transactionId: 1, collaboratorAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", amountReceived: "100.0000000" },
  ],
  secondarySales: [],
  secondaryRoyaltyDistributions: [],
  auditLog: [{ id: 1, contractId: CONTRACT, action: "distribution_initiated" }],
  metrics: {
    transactionCount: 1,
    collaboratorCount: 1,
    secondarySaleCount: 0,
    auditLogCount: 1,
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Suite 1 — contract-backup unit tests
// ─────────────────────────────────────────────────────────────────────────────

describe("contract-backup — buildSnapshot", () => {
  const mockAll = jest.fn();
  const mockPrepare = jest.fn(() => ({ all: mockAll, run: jest.fn() }));

  await jest.unstable_mockModule("../src/database/core.js", () => ({
    db: { prepare: mockPrepare },
    countWrite: jest.fn(),
  }));

  await jest.unstable_mockModule("../src/database/index.js", () => ({
    createBackupRecord:    jest.fn(() => 1),
    markBackupUploading:   jest.fn(),
    markBackupCompleted:   jest.fn(),
    markBackupFailed:      jest.fn(),
    backupExistsForWeek:   jest.fn(() => false),
    pruneOldBackups:       jest.fn(() => 0),
    getContractsWithBackups: jest.fn(() => []),
    getIsoWeek:            jest.fn(() => ({ weekNumber: 39, yearNumber: 2026 })),
    addAuditLog:           jest.fn(),
  }));

  const { buildSnapshot } = await import("../src/services/contract-backup.js");

  beforeEach(() => {
    jest.clearAllMocks();
    // Default: return empty arrays for all .all() calls
    mockAll.mockReturnValue([]);
  });

  test("includes all required top-level keys", () => {
    const snap = buildSnapshot(CONTRACT);
    expect(snap).toHaveProperty("version", 1);
    expect(snap).toHaveProperty("contractId", CONTRACT);
    expect(snap).toHaveProperty("snapshotAt");
    expect(snap).toHaveProperty("transactions");
    expect(snap).toHaveProperty("distributionPayouts");
    expect(snap).toHaveProperty("secondarySales");
    expect(snap).toHaveProperty("secondaryRoyaltyDistributions");
    expect(snap).toHaveProperty("auditLog");
    expect(snap).toHaveProperty("metrics");
  });

  test("metrics.transactionCount matches transactions array length", () => {
    mockAll
      .mockReturnValueOnce([{ id: 1 }, { id: 2 }]) // transactions
      .mockReturnValueOnce([])                        // distributionPayouts
      .mockReturnValueOnce([])                        // secondarySales
      .mockReturnValueOnce([])                        // secondaryRoyaltyDistributions
      .mockReturnValueOnce([]);                       // auditLog

    const snap = buildSnapshot(CONTRACT);
    expect(snap.metrics.transactionCount).toBe(2);
    expect(snap.transactions).toHaveLength(2);
  });

  test("derives unique collaboratorCount from distributionPayouts", () => {
    const addr1 = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const addr2 = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

    mockAll
      .mockReturnValueOnce([{ id: 1 }])  // transactions
      .mockReturnValueOnce([              // distributionPayouts — addr1 appears twice
        { transactionId: 1, collaboratorAddress: addr1, amountReceived: "50" },
        { transactionId: 1, collaboratorAddress: addr1, amountReceived: "50" },
        { transactionId: 1, collaboratorAddress: addr2, amountReceived: "100" },
      ])
      .mockReturnValueOnce([])
      .mockReturnValueOnce([])
      .mockReturnValueOnce([]);

    const snap = buildSnapshot(CONTRACT);
    expect(snap.metrics.collaboratorCount).toBe(2); // unique addresses
  });
});

describe("contract-backup — uploadToIpfs dry-run", () => {
  // No PINATA_JWT set → dry-run mode
  await jest.unstable_mockModule("../src/database/index.js", () => ({
    getIsoWeek: jest.fn(() => ({ weekNumber: 39, yearNumber: 2026 })),
    addAuditLog: jest.fn(),
    createBackupRecord: jest.fn(() => 1),
    markBackupUploading: jest.fn(),
    markBackupCompleted: jest.fn(),
    markBackupFailed: jest.fn(),
    backupExistsForWeek: jest.fn(() => false),
    pruneOldBackups: jest.fn(() => 0),
    getContractsWithBackups: jest.fn(() => []),
  }));

  await jest.unstable_mockModule("../src/database/core.js", () => ({
    db: { prepare: jest.fn(() => ({ all: jest.fn(() => []), run: jest.fn() })) },
    countWrite: jest.fn(),
  }));

  const { uploadToIpfs } = await import("../src/services/contract-backup.js");

  test("returns a stub CID in dry-run mode", async () => {
    const result = await uploadToIpfs(MOCK_SNAPSHOT, CONTRACT);
    expect(result.cid).toMatch(/^bafyDRYRUN/);
    expect(result.sizeBytes).toBeGreaterThan(0);
    expect(result.gatewayUrl).toContain(result.cid);
  });
});

describe("contract-backup — takeSnapshot", () => {
  const createBackupRecordMock = jest.fn(() => 42);
  const markBackupUploadingMock = jest.fn();
  const markBackupCompletedMock = jest.fn();
  const markBackupFailedMock = jest.fn();
  const backupExistsForWeekMock = jest.fn(() => false);
  const pruneOldBackupsMock = jest.fn(() => 0);
  const addAuditLogMock = jest.fn();

  await jest.unstable_mockModule("../src/database/index.js", () => ({
    createBackupRecord:    createBackupRecordMock,
    markBackupUploading:   markBackupUploadingMock,
    markBackupCompleted:   markBackupCompletedMock,
    markBackupFailed:      markBackupFailedMock,
    backupExistsForWeek:   backupExistsForWeekMock,
    pruneOldBackups:       pruneOldBackupsMock,
    getIsoWeek:            jest.fn(() => ({ weekNumber: 39, yearNumber: 2026 })),
    getContractsWithBackups: jest.fn(() => []),
    addAuditLog:           addAuditLogMock,
  }));

  await jest.unstable_mockModule("../src/database/core.js", () => ({
    db: { prepare: jest.fn(() => ({ all: jest.fn(() => []), run: jest.fn() })) },
    countWrite: jest.fn(),
  }));

  const { takeSnapshot } = await import("../src/services/contract-backup.js");

  beforeEach(() => jest.clearAllMocks());

  test("returns null when backup already exists for the week", async () => {
    backupExistsForWeekMock.mockReturnValueOnce(true);
    const result = await takeSnapshot(CONTRACT);
    expect(result).toBeNull();
    expect(createBackupRecordMock).not.toHaveBeenCalled();
  });

  test("force=true bypasses duplicate week guard", async () => {
    backupExistsForWeekMock.mockReturnValueOnce(true);
    const result = await takeSnapshot(CONTRACT, new Date(), { force: true });
    expect(result).not.toBeNull();
    expect(createBackupRecordMock).toHaveBeenCalled();
  });

  test("creates backup record and marks completed on success", async () => {
    const result = await takeSnapshot(CONTRACT);
    expect(result.backupId).toBe(42);
    expect(markBackupUploadingMock).toHaveBeenCalledWith(42);
    expect(markBackupCompletedMock).toHaveBeenCalledWith(42, expect.objectContaining({ ipfsCid: expect.any(String) }));
    expect(pruneOldBackupsMock).toHaveBeenCalledWith(CONTRACT);
    expect(addAuditLogMock).toHaveBeenCalledWith(CONTRACT, "contract_backup_completed", "system", expect.anything());
  });

  test("marks backup failed and re-throws on upload error", async () => {
    // Make uploadToIpfs fail by temporarily breaking fetch (it uses global fetch)
    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockRejectedValue(new Error("network down"));

    await expect(takeSnapshot(CONTRACT)).rejects.toThrow();
    expect(markBackupFailedMock).toHaveBeenCalledWith(42, expect.stringContaining("network down"));

    global.fetch = originalFetch;
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 2 — disaster-recovery unit tests
// ─────────────────────────────────────────────────────────────────────────────

describe("disaster-recovery — validateSnapshot", () => {
  // Pure function — no mocks needed
  const { validateSnapshot } = await import("../src/services/disaster-recovery.js");

  test("returns empty array for a valid snapshot", () => {
    expect(validateSnapshot(MOCK_SNAPSHOT)).toHaveLength(0);
  });

  test("errors on non-object input", () => {
    expect(validateSnapshot(null)).toContain("snapshot is not an object");
    expect(validateSnapshot("string")).toContain("snapshot is not an object");
  });

  test("errors on wrong version", () => {
    const errors = validateSnapshot({ ...MOCK_SNAPSHOT, version: 99 });
    expect(errors.some((e) => e.includes("version"))).toBe(true);
  });

  test("errors when transactions array is missing", () => {
    const { transactions: _t, ...rest } = MOCK_SNAPSHOT;
    const errors = validateSnapshot(rest);
    expect(errors.some((e) => e.includes("transactions"))).toBe(true);
  });

  test("errors on transaction count mismatch", () => {
    const errors = validateSnapshot({
      ...MOCK_SNAPSHOT,
      transactions: [],           // empty but metrics says 1
      metrics: { ...MOCK_SNAPSHOT.metrics, transactionCount: 1 },
    });
    expect(errors.some((e) => e.includes("count mismatch"))).toBe(true);
  });

  test("errors when metrics object is missing", () => {
    const { metrics: _m, ...rest } = MOCK_SNAPSHOT;
    const errors = validateSnapshot(rest);
    expect(errors.some((e) => e.includes("metrics"))).toBe(true);
  });
});

describe("disaster-recovery — buildRecoveryBundle", () => {
  const { buildRecoveryBundle } = await import("../src/services/disaster-recovery.js");

  test("includes all required bundle fields", () => {
    const bundle = buildRecoveryBundle(MOCK_SNAPSHOT);
    expect(bundle).toHaveProperty("migrationManifest");
    expect(bundle).toHaveProperty("collaborators");
    expect(bundle).toHaveProperty("transactionHistory");
    expect(bundle).toHaveProperty("secondarySales");
    expect(bundle).toHaveProperty("auditLog");
    expect(bundle).toHaveProperty("instructions");
  });

  test("derives correct collaborator list from payouts", () => {
    const bundle = buildRecoveryBundle(MOCK_SNAPSHOT);
    expect(bundle.collaborators).toHaveLength(1);
    expect(bundle.collaborators[0].address).toBe(
      "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    );
    expect(bundle.collaborators[0].totalReceived).toBe("100.0000000");
  });

  test("embeds payouts inside transactionHistory", () => {
    const bundle = buildRecoveryBundle(MOCK_SNAPSHOT);
    expect(bundle.transactionHistory[0].payouts).toHaveLength(1);
  });

  test("migrationManifest lists required actions", () => {
    const bundle = buildRecoveryBundle(MOCK_SNAPSHOT);
    expect(bundle.migrationManifest.requiredActions.length).toBeGreaterThan(0);
    expect(bundle.migrationManifest.collaboratorCount).toBe(1);
  });

  test("aggregates multiple payouts per collaborator correctly", () => {
    const snap = {
      ...MOCK_SNAPSHOT,
      distributionPayouts: [
        { transactionId: 1, collaboratorAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", amountReceived: "60.0" },
        { transactionId: 1, collaboratorAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", amountReceived: "40.0" },
      ],
    };
    const bundle = buildRecoveryBundle(snap);
    expect(bundle.collaborators[0].totalReceived).toBe("100.0000000");
  });
});

describe("disaster-recovery — runRecoveryDrill", () => {
  const getLatestBackupMock = jest.fn();
  const getBackupByIdMock = jest.fn();
  const recordDrillResultMock = jest.fn();
  const addAuditLogMock = jest.fn();

  await jest.unstable_mockModule("../src/database/index.js", () => ({
    getLatestBackup:    getLatestBackupMock,
    getBackupById:      getBackupByIdMock,
    recordDrillResult:  recordDrillResultMock,
    addAuditLog:        addAuditLogMock,
  }));

  const { runRecoveryDrill } = await import("../src/services/disaster-recovery.js");

  const MOCK_BACKUP_RECORD = {
    id: 7,
    contractId: CONTRACT,
    ipfsCid: "bafyDRYRUNCAAAAAAAAW2026W39",
    status: "completed",
    createdAt: new Date().toISOString(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    getLatestBackupMock.mockReturnValue(MOCK_BACKUP_RECORD);
    // Stub fetch to return a valid snapshot
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => MOCK_SNAPSHOT,
    });
  });

  test("returns passed:true for a valid snapshot", async () => {
    const result = await runRecoveryDrill(CONTRACT);
    expect(result.passed).toBe(true);
    expect(result.backupId).toBe(7);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.validationErrors).toHaveLength(0);
    expect(recordDrillResultMock).toHaveBeenCalledWith(7, true, expect.any(Number));
  });

  test("returns passed:false when snapshot validation fails", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ...MOCK_SNAPSHOT, version: 99 }),
    });
    const result = await runRecoveryDrill(CONTRACT);
    expect(result.passed).toBe(false);
    expect(result.validationErrors.length).toBeGreaterThan(0);
    expect(recordDrillResultMock).toHaveBeenCalledWith(7, false, expect.any(Number));
  });

  test("returns passed:false when all gateways fail", async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error("timeout"));
    const result = await runRecoveryDrill(CONTRACT);
    expect(result.passed).toBe(false);
    expect(result.validationErrors[0]).toMatch(/failed/i);
  });

  test("throws when no backup record exists", async () => {
    getLatestBackupMock.mockReturnValue(null);
    await expect(runRecoveryDrill(CONTRACT)).rejects.toThrow(/No completed backup/);
  });

  test("uses specific backupId when provided", async () => {
    getBackupByIdMock.mockReturnValue(MOCK_BACKUP_RECORD);
    await runRecoveryDrill(CONTRACT, 7);
    expect(getBackupByIdMock).toHaveBeenCalledWith(7);
  });

  test("records drill result in audit log", async () => {
    await runRecoveryDrill(CONTRACT);
    expect(addAuditLogMock).toHaveBeenCalledWith(
      CONTRACT,
      "recovery_drill_completed",
      "system",
      expect.objectContaining({ passed: true, backupId: 7 }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 3 — route integration tests
// ─────────────────────────────────────────────────────────────────────────────

describe("backup routes — integration", () => {
  const listBackupsMock          = jest.fn(() => []);
  const countBackupsMock         = jest.fn(() => 0);
  const getLatestBackupMock      = jest.fn(() => null);
  const getBackupByIdMock        = jest.fn(() => null);
  const takeSnapshotMock         = jest.fn();
  const exportRecoveryBundleMock = jest.fn();
  const runRecoveryDrillMock     = jest.fn();

  await jest.unstable_mockModule("../src/database/index.js", () => ({
    listBackups:       listBackupsMock,
    countBackups:      countBackupsMock,
    getLatestBackup:   getLatestBackupMock,
    getBackupById:     getBackupByIdMock,
    initializeDatabase: jest.fn(),
    getMigrationVersion: jest.fn(() => 9),
    addAuditLog:       jest.fn(),
    recordTransaction: jest.fn(),
  }));

  await jest.unstable_mockModule("../src/services/contract-backup.js", () => ({
    takeSnapshot:       takeSnapshotMock,
    startBackupScheduler: jest.fn(() => ({ stop: jest.fn() })),
  }));

  await jest.unstable_mockModule("../src/services/disaster-recovery.js", () => ({
    exportRecoveryBundle: exportRecoveryBundleMock,
    runRecoveryDrill:    runRecoveryDrillMock,
  }));

  // Admin token for protected routes
  process.env.ADMIN_ROTATE_TOKEN = "test-admin-token-secure";

  const { default: app } = await import("./app.js");

  const AUTH = { Authorization: "Bearer test-admin-token-secure" };

  beforeEach(() => jest.clearAllMocks());

  // ── GET /api/v1/backup/:contractId ────────────────────────────────────────

  test("GET list — 200 returns backup history", async () => {
    const mockRecord = { id: 1, contractId: CONTRACT, status: "completed" };
    listBackupsMock.mockReturnValueOnce([mockRecord]);
    countBackupsMock.mockReturnValueOnce(1);

    const res = await request(app).get(`/api/v1/backup/${CONTRACT}`);
    expect(res.status).toBe(200);
    expect(res.body.backups).toHaveLength(1);
    expect(res.body.total).toBe(1);
  });

  test("GET list — 400 for invalid contractId", async () => {
    const res = await request(app).get("/api/v1/backup/INVALID");
    expect(res.status).toBe(400);
  });

  // ── GET /api/v1/backup/:contractId/latest ─────────────────────────────────

  test("GET latest — 200 returns most recent backup", async () => {
    getLatestBackupMock.mockReturnValueOnce({ id: 5, status: "completed", ipfsCid: "bafyXXX" });
    const res = await request(app).get(`/api/v1/backup/${CONTRACT}/latest`);
    expect(res.status).toBe(200);
    expect(res.body.backup.id).toBe(5);
  });

  test("GET latest — 404 when no backup exists", async () => {
    getLatestBackupMock.mockReturnValueOnce(null);
    const res = await request(app).get(`/api/v1/backup/${CONTRACT}/latest`);
    expect(res.status).toBe(404);
  });

  // ── POST /api/v1/backup/trigger ───────────────────────────────────────────

  test("POST trigger — 401 without auth", async () => {
    const res = await request(app)
      .post("/api/v1/backup/trigger")
      .send({ contractId: CONTRACT });
    expect(res.status).toBe(401);
    expect(takeSnapshotMock).not.toHaveBeenCalled();
  });

  test("POST trigger — 201 on successful snapshot", async () => {
    takeSnapshotMock.mockResolvedValueOnce({
      backupId: 10,
      cid: "bafyABC",
      gatewayUrl: "https://gateway.pinata.cloud/ipfs/bafyABC",
      sizeBytes: 1024,
      metrics: { transactionCount: 5 },
      dryRun: true,
    });

    const res = await request(app)
      .post("/api/v1/backup/trigger")
      .set(AUTH)
      .send({ contractId: CONTRACT });

    expect(res.status).toBe(201);
    expect(res.body.backupId).toBe(10);
    expect(res.body.cid).toBe("bafyABC");
    expect(res.body.dryRun).toBe(true);
  });

  test("POST trigger — 200 skipped when backup already exists this week", async () => {
    takeSnapshotMock.mockResolvedValueOnce(null);

    const res = await request(app)
      .post("/api/v1/backup/trigger")
      .set(AUTH)
      .send({ contractId: CONTRACT });

    expect(res.status).toBe(200);
    expect(res.body.skipped).toBe(true);
  });

  test("POST trigger — 400 when contractId is missing", async () => {
    const res = await request(app)
      .post("/api/v1/backup/trigger")
      .set(AUTH)
      .send({});
    expect(res.status).toBe(400);
  });

  // ── POST /api/v1/backup/:contractId/drill ─────────────────────────────────

  test("POST drill — 200 returns drill result", async () => {
    runRecoveryDrillMock.mockResolvedValueOnce({
      passed: true,
      backupId: 5,
      cid: "bafyXXX",
      durationMs: 800,
      rpoWithinThreshold: true,
      snapshotAgeMs: 3600000,
      validationErrors: [],
      summary: "Drill PASSED in 800ms.",
    });

    const res = await request(app)
      .post(`/api/v1/backup/${CONTRACT}/drill`)
      .set(AUTH)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.passed).toBe(true);
    expect(res.body.durationMs).toBe(800);
  });

  test("POST drill — 401 without auth", async () => {
    const res = await request(app)
      .post(`/api/v1/backup/${CONTRACT}/drill`)
      .send({});
    expect(res.status).toBe(401);
  });

  test("POST drill — 404 when no backup exists", async () => {
    runRecoveryDrillMock.mockRejectedValueOnce(new Error("No completed backup found"));
    const res = await request(app)
      .post(`/api/v1/backup/${CONTRACT}/drill`)
      .set(AUTH)
      .send({});
    expect(res.status).toBe(404);
  });

  // ── GET /api/v1/backup/:contractId/export/:backupId ───────────────────────

  test("GET export — 200 returns recovery bundle", async () => {
    getBackupByIdMock.mockReturnValueOnce({ id: 5, contractId: CONTRACT, status: "completed", ipfsCid: "bafyXXX" });
    exportRecoveryBundleMock.mockResolvedValueOnce({
      contractId: CONTRACT,
      collaborators: [{ address: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", totalReceived: "100.0000000" }],
      migrationManifest: { collaboratorCount: 1, requiredActions: [] },
    });

    const res = await request(app)
      .get(`/api/v1/backup/${CONTRACT}/export/5`)
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.collaborators).toHaveLength(1);
  });

  test("GET export — 401 without auth", async () => {
    const res = await request(app).get(`/api/v1/backup/${CONTRACT}/export/5`);
    expect(res.status).toBe(401);
  });

  test("GET export — 404 when backup not found for contract", async () => {
    getBackupByIdMock.mockReturnValueOnce(null);
    const res = await request(app)
      .get(`/api/v1/backup/${CONTRACT}/export/999`)
      .set(AUTH);
    expect(res.status).toBe(404);
  });

  test("GET export — 404 when backup belongs to different contract", async () => {
    const OTHER = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
    getBackupByIdMock.mockReturnValueOnce({ id: 5, contractId: OTHER, status: "completed" });
    const res = await request(app)
      .get(`/api/v1/backup/${CONTRACT}/export/5`)
      .set(AUTH);
    expect(res.status).toBe(404);
  });
});
