import { jest, describe, test, expect, beforeEach } from "@jest/globals";
import request from "supertest";

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockBuildAuthUrl = jest.fn();
const mockExchangeCodeForToken = jest.fn();
const mockCreateInvoice = jest.fn();
const mockCreateJournalEntry = jest.fn();
const mockVerifyWebhookSignature = jest.fn();
const mockParseWebhookPayload = jest.fn();
const mockIsInvoicePaid = jest.fn();

await jest.unstable_mockModule("../src/services/quickbooks.js", () => ({
  buildAuthUrl: mockBuildAuthUrl,
  exchangeCodeForToken: mockExchangeCodeForToken,
  createInvoice: mockCreateInvoice,
  createJournalEntry: mockCreateJournalEntry,
  verifyWebhookSignature: mockVerifyWebhookSignature,
  parseWebhookPayload: mockParseWebhookPayload,
  isInvoicePaid: mockIsInvoicePaid,
}));

const mockEnsureAccountingSyncTables = jest.fn();
const mockGetQuickBooksConnection = jest.fn();
const mockGetUnsyncedDistributionTransactions = jest.fn();
const mockGetDistributionTransactionById = jest.fn();
const mockGetDistributionPayouts = jest.fn();
const mockCreateAccountingSync = jest.fn();
const mockUpdateAccountingSyncStatus = jest.fn();
const mockAddAccountingSyncItem = jest.fn();
const mockMarkAccountingSyncItemSynced = jest.fn();
const mockMarkAccountingSyncItemFailed = jest.fn();
const mockMarkAccountingSyncItemConfirmed = jest.fn();
const mockGetAccountingSync = jest.fn();
const mockGetLatestAccountingSync = jest.fn();
const mockGetRecentAccountingSyncs = jest.fn();
const mockGetAccountingSyncItems = jest.fn();
const mockRedeemQuickBooksOAuthState = jest.fn();

await jest.unstable_mockModule("../src/database/accounting-sync.js", () => ({
  ensureAccountingSyncTables: mockEnsureAccountingSyncTables,
  getQuickBooksConnection: mockGetQuickBooksConnection,
  getUnsyncedDistributionTransactions: mockGetUnsyncedDistributionTransactions,
  getDistributionTransactionById: mockGetDistributionTransactionById,
  getDistributionPayouts: mockGetDistributionPayouts,
  createAccountingSync: mockCreateAccountingSync,
  updateAccountingSyncStatus: mockUpdateAccountingSyncStatus,
  addAccountingSyncItem: mockAddAccountingSyncItem,
  markAccountingSyncItemSynced: mockMarkAccountingSyncItemSynced,
  markAccountingSyncItemFailed: mockMarkAccountingSyncItemFailed,
  markAccountingSyncItemConfirmed: mockMarkAccountingSyncItemConfirmed,
  getAccountingSync: mockGetAccountingSync,
  getLatestAccountingSync: mockGetLatestAccountingSync,
  getRecentAccountingSyncs: mockGetRecentAccountingSyncs,
  getAccountingSyncItems: mockGetAccountingSyncItems,
  redeemQuickBooksOAuthState: mockRedeemQuickBooksOAuthState,
}));

const mockAddAuditLog = jest.fn();
await jest.unstable_mockModule("../src/database/audit.js", () => ({
  addAuditLog: mockAddAuditLog,
}));

const mockRecordAuditEvent = jest.fn();
await jest.unstable_mockModule("../src/services/audit-trail.js", () => ({
  recordAuditEvent: mockRecordAuditEvent,
}));

await jest.unstable_mockModule("../src/middleware/rbac.js", () => ({
  requireRole: () => (req, _res, next) => {
    req.role = "admin";
    next();
  },
}));

await jest.unstable_mockModule("../src/database/index.js", () => ({
  initializeDatabase: jest.fn(),
  getMigrationVersion: jest.fn(() => 1),
}));

import express from "express";
const { quickbooksRouter } = await import("../src/routes/accounting/quickbooks.js");

const app = express();
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.use("/api/v1/accounting/quickbooks", quickbooksRouter);

app.use((err, _req, res, _next) => {
  res.status(500).json({ error: err.message ?? "Internal server error" });
});

// ── Fixtures ─────────────────────────────────────────────────────────────────

const REALM = "123456789";
const INVOICE_ID = "302";
const JOURNAL_ID = "7001";

const mockDistribution = {
  id: 42,
  contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  type: "distribute",
  initiatorAddress: "GAPTAQKSMN2ILFVHXDE5V274BUPC6QCRMJZYJFNGW7ENT2X3BQOS4M3C",
  requestedAmount: "1000",
  timestamp: "2026-09-01T00:00:00.000Z",
  status: "confirmed",
  payoutCount: 2,
  totalPayout: 1000,
};

const mockPayouts = [
  { collaboratorAddress: "GAPTAQKSMN2ILFVHXDE5V274BUPC6QCRMJZYJFNGW7ENT2X3BQOS4M3C", amountReceived: "600" },
  { collaboratorAddress: "GA7E6YDRQKJ2JNOG27UPSCQ3FQ6U4X3QQGJKHNGF23T7QCI2FM6E3W2P", amountReceived: "400" },
];

function mockSyncItem(overrides = {}) {
  return {
    id: 10,
    sync_id: 1,
    transaction_id: 42,
    kind: "invoice",
    recipient: "GAPTAQKSMN2ILFVHXDE5V274BUPC6QCRMJZYJFNGW7ENT2X3BQOS4M3C",
    amount: "600",
    quickbooks_id: INVOICE_ID,
    status: "synced",
    detail: null,
    ...overrides,
  };
}

describe("QuickBooks accounting routes (#940)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockBuildAuthUrl.mockResolvedValue({
      authUrl: "https://appcenter.intuit.com/connect/oauth2?client_id=x",
      state: "state-123",
    });
    mockRedeemQuickBooksOAuthState.mockReturnValue(true);
    mockGetQuickBooksConnection.mockReturnValue({ realm_id: REALM, status: "connected" });
    mockCreateAccountingSync.mockReturnValue({ id: 7, realm_id: REALM, sync_type: "distributions", status: "in_progress" });
    mockUpdateAccountingSyncStatus.mockImplementation(({ syncId }) => ({
      id: syncId,
      realm_id: REALM,
      sync_type: "distributions",
      status: "completed",
      summary: JSON.stringify({ distributions: 1, invoicesCreated: 2, journalEntriesCreated: 1 }),
    }));
    mockAddAccountingSyncItem.mockReturnValue(mockSyncItem());
    mockMarkAccountingSyncItemSynced.mockReturnValue(mockSyncItem());
    mockMarkAccountingSyncItemFailed.mockImplementation((id, detail) => mockSyncItem({ id, detail, status: "failed" }));
    mockGetLatestAccountingSync.mockReturnValue(null);
    mockGetRecentAccountingSyncs.mockReturnValue([]);
  });

  describe("POST /connect", () => {
    test("returns an OAuth auth URL when called without a code", async () => {
      const res = await request(app).post("/api/v1/accounting/quickbooks/connect").send({});

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.authUrl).toContain("oauth2");
      expect(res.body.data.state).toBe("state-123");
      expect(mockBuildAuthUrl).toHaveBeenCalledTimes(1);
      expect(mockExchangeCodeForToken).not.toHaveBeenCalled();
    });

    test("completes the OAuth exchange with a code + state and persists the connection", async () => {
      mockExchangeCodeForToken.mockResolvedValue({ realmId: REALM, expiresAt: "2026-10-01T00:00:00.000Z" });

      const res = await request(app)
        .post("/api/v1/accounting/quickbooks/connect")
        .send({ code: "auth-code-1", realmId: REALM, state: "state-123" });

      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({ connected: true, realmId: REALM });
      expect(mockExchangeCodeForToken).toHaveBeenCalledWith({ code: "auth-code-1", realmId: REALM });
      expect(mockRedeemQuickBooksOAuthState).toHaveBeenCalledWith("state-123");
      expect(mockAddAuditLog).toHaveBeenCalledWith(
        REALM,
        "quickbooks_connected",
        expect.any(String),
        expect.objectContaining({ realmId: REALM })
      );
    });

    test("rejects a stale / unknown OAuth state token", async () => {
      mockRedeemQuickBooksOAuthState.mockReturnValue(false);
      mockExchangeCodeForToken.mockResolvedValue({ realmId: REALM });

      const res = await request(app)
        .post("/api/v1/accounting/quickbooks/connect")
        .send({ code: "auth-code-1", realmId: REALM, state: "expired" });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("invalid_oauth_state");
      expect(mockExchangeCodeForToken).not.toHaveBeenCalled();
    });

    test("returns validation error for a malformed body", async () => {
      const res = await request(app)
        .post("/api/v1/accounting/quickbooks/connect")
        .send({ code: 12345 });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("validation_failed");
    });
  });

  describe("POST /sync-distributions", () => {
    test("creates an invoice per payout and one journal entry per distribution", async () => {
      mockGetUnsyncedDistributionTransactions.mockReturnValue([mockDistribution]);
      mockGetDistributionPayouts.mockReturnValue(mockPayouts);
      mockCreateInvoice.mockResolvedValueOnce({ id: INVOICE_ID })
        .mockResolvedValueOnce({ id: "867" });
      mockCreateJournalEntry.mockResolvedValue({ id: JOURNAL_ID });

      const res = await request(app)
        .post("/api/v1/accounting/quickbooks/sync-distributions")
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        syncId: 7,
        status: "completed",
        distributions: 1,
        invoicesCreated: 2,
        journalEntriesCreated: 1,
        successCount: 3,
        failureCount: 0,
      });

      // Invoice per collaborator payout with the correct amount + recipient
      expect(mockCreateInvoice).toHaveBeenNthCalledWith(1, expect.objectContaining({
        recipient: "GAPTAQKSMN2ILFVHXDE5V274BUPC6QCRMJZYJFNGW7ENT2X3BQOS4M3C",
        amount: "600",
        realmId: REALM,
      }));
      expect(mockCreateInvoice).toHaveBeenNthCalledWith(2, expect.objectContaining({
        recipient: "GA7E6YDRQKJ2JNOG27UPSCQ3FQ6U4X3QQGJKHNGF23T7QCI2FM6E3W2P",
        amount: "400",
      }));

      // Journal entry for the royalty pool transfer
      expect(mockCreateJournalEntry).toHaveBeenCalledWith(expect.objectContaining({
        amount: "1000",
        realmId: REALM,
      }));

      expect(mockMarkAccountingSyncItemSynced).toHaveBeenCalledTimes(3);
      expect(mockAddAuditLog).toHaveBeenCalledWith(
        REALM,
        "quickbooks_distributions_synced",
        expect.any(String),
        expect.objectContaining({ syncId: 7, invoicesCreated: 2 })
      );
      expect(mockRecordAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: "quickbooks_distributions_synced" })
      );
    });

    test("supports restricing to explicit transactionIds", async () => {
      mockGetDistributionTransactionById.mockReturnValue(mockDistribution);
      mockGetDistributionPayouts.mockReturnValue(mockPayouts);
      mockCreateInvoice.mockResolvedValue({ id: INVOICE_ID });
      mockCreateJournalEntry.mockResolvedValue({ id: JOURNAL_ID });

      const res = await request(app)
        .post("/api/v1/accounting/quickbooks/sync-distributions")
        .send({ transactionIds: [42] });

      expect(res.status).toBe(200);
      expect(mockGetDistributionTransactionById).toHaveBeenCalledWith(42);
      expect(res.body.data.distributions).toBe(1);
    });

    test("is a no-op when no unsynced distributions exist", async () => {
      mockGetUnsyncedDistributionTransactions.mockReturnValue([]);

      const res = await request(app)
        .post("/api/v1/accounting/quickbooks/sync-distributions")
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.data.invoicesCreated).toBe(0);
      expect(res.body.data.message).toMatch(/no unsynced/i);
      expect(mockCreateAccountingSync).not.toHaveBeenCalled();
    });

    test("409 when no QuickBooks company is connected", async () => {
      mockGetQuickBooksConnection.mockReturnValue(null);
      delete process.env.QUICKBOOKS_REALM_ID;

      const res = await request(app)
        .post("/api/v1/accounting/quickbooks/sync-distributions")
        .send({});

      expect(res.status).toBe(409);
      expect(res.body.code).toBe("quickbooks_not_connected");
    });

    test("tracks partial failure when QuickBooks rejects an entity", async () => {
      mockGetUnsyncedDistributionTransactions.mockReturnValue([mockDistribution]);
      mockGetDistributionPayouts.mockReturnValue(mockPayouts);
      mockCreateInvoice.mockRejectedValueOnce(new Error("QB 400: invalid item"))
        .mockResolvedValueOnce({ id: "867" });
      mockCreateJournalEntry.mockResolvedValue({ id: JOURNAL_ID });
      mockUpdateAccountingSyncStatus.mockImplementation(({ syncId }) => ({
        id: syncId,
        status: "partial",
      }));

      const res = await request(app)
        .post("/api/v1/accounting/quickbooks/sync-distributions")
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("partial");
      expect(res.body.data.failureCount).toBe(1);
      expect(mockMarkAccountingSyncItemFailed).toHaveBeenCalledTimes(1);
    });
  });

  describe("POST /webhook", () => {
    test("marks matching invoices confirmed when paid", async () => {
      mockVerifyWebhookSignature.mockReturnValue(true);
      mockParseWebhookPayload.mockReturnValue([
        { type: "Invoice", id: INVOICE_ID, operation: "Update", realmId: REALM },
      ]);
      mockIsInvoicePaid.mockResolvedValue(true);
      mockMarkAccountingSyncItemConfirmed.mockReturnValue(
        mockSyncItem({ status: "confirmed", transaction_id: 42 })
      );

      const body = JSON.stringify({ eventNotifications: [] });
      const res = await request(app)
        .post("/api/v1/accounting/quickbooks/webhook")
        .set("intuit-signature", "sig")
        .send(body);

      expect(res.status).toBe(200);
      expect(mockMarkAccountingSyncItemConfirmed).toHaveBeenCalledWith(INVOICE_ID);
      expect(mockAddAuditLog).toHaveBeenCalledWith(
        REALM,
        "quickbooks_invoice_paid",
        "quickbooks-webhook",
        expect.objectContaining({ invoiceId: INVOICE_ID, transactionId: 42 })
      );
    });

    test("ignores invoices that are not fully paid", async () => {
      mockVerifyWebhookSignature.mockReturnValue(true);
      mockParseWebhookPayload.mockReturnValue([
        { type: "Invoice", id: INVOICE_ID, operation: "Update", realmId: REALM },
      ]);
      mockIsInvoicePaid.mockResolvedValue(false);

      await request(app)
        .post("/api/v1/accounting/quickbooks/webhook")
        .set("intuit-signature", "sig")
        .send(JSON.stringify({}));

      expect(mockMarkAccountingSyncItemConfirmed).not.toHaveBeenCalled();
    });

    test("rejects a bad intuit-signature with 401", async () => {
      mockVerifyWebhookSignature.mockReturnValue(false);

      const res = await request(app)
        .post("/api/v1/accounting/quickbooks/webhook")
        .set("intuit-signature", "bad-sig")
        .send(JSON.stringify({}));

      expect(res.status).toBe(401);
      expect(res.body.code).toBe("invalid_signature");
    });
  });

  describe("GET /status", () => {
    test("reports connection + latest sync state", async () => {
      mockGetLatestAccountingSync.mockReturnValue({
        id: 7,
        realm_id: REALM,
        sync_type: "distributions",
        status: "completed",
        total_items: 3,
        success_count: 3,
        failure_count: 0,
        summary: JSON.stringify({ distributions: 1, invoicesCreated: 2, journalEntriesCreated: 1 }),
        item_count: 3,
      });

      const res = await request(app).get("/api/v1/accounting/quickbooks/status");

      expect(res.status).toBe(200);
      expect(res.body.data.connected).toBe(true);
      expect(res.body.data.connection.realmId).toBe(REALM);
      expect(res.body.data.latestSync.status).toBe("completed");
      expect(res.body.data.latestSync.summary.invoicesCreated).toBe(2);
    });
  });

  describe("GET /syncs/:syncId", () => {
    test("returns a sync run with its items", async () => {
      mockGetAccountingSync.mockReturnValue({
        id: 7, realm_id: REALM, sync_type: "distributions", status: "completed",
        summary: null, item_count: 2,
      });
      mockGetAccountingSyncItems.mockReturnValue([
        mockSyncItem(),
        mockSyncItem({ id: 11, kind: "journal_entry", quickbooks_id: JOURNAL_ID }),
      ]);

      const res = await request(app).get("/api/v1/accounting/quickbooks/syncs/7");

      expect(res.status).toBe(200);
      expect(res.body.data.items).toHaveLength(2);
    });

    test("404 for an unknown sync run", async () => {
      mockGetAccountingSync.mockReturnValue(null);
      const res = await request(app).get("/api/v1/accounting/quickbooks/syncs/999");
      expect(res.status).toBe(404);
    });
  });
});