/**
 * Route-level tests for the Salesforce CRM endpoints (#939).
 *
 * Persistence and the Salesforce HTTP client are mocked so these tests cover
 * request validation, orchestration, and response shaping without a network
 * or database.
 */
import { jest, describe, test, expect, beforeEach, afterEach } from "@jest/globals";
import request from "supertest";

const CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
const ADDRESS = "GAPTAQKSMN2ILFVHXDE5V274BUPC6QCRMJZYJFNGW7ENT2X3BQOS4M3C";

const mockCreateContact = jest.fn();
const mockUpdateContact = jest.fn();
const mockCreateActivity = jest.fn();
const salesforceClient = {
  createContact: mockCreateContact,
  updateContact: mockUpdateContact,
  createActivity: mockCreateActivity,
};

const mockAddAuditLog = jest.fn();
const mockSetContributorStatus = jest.fn();

const crmStore = {
  getConnection: jest.fn(),
  saveConnection: jest.fn(),
  disconnectConnection: jest.fn(),
  updateConnectionTokens: jest.fn(),
  getSyncStatus: jest.fn(),
  startSync: jest.fn(),
  incrementSyncProgress: jest.fn(),
  finishSync: jest.fn(),
  upsertContactMapping: jest.fn(),
  getContactMappingByAddress: jest.fn(),
  findContactMappingByExternalId: jest.fn(),
  listContactMappings: jest.fn(),
  recordCrmActivity: jest.fn(),
  listCrmActivities: jest.fn(),
  listKnownCollaborators: jest.fn(),
};

const mockVerifyOAuthState = jest.fn();
const mockExchangeCode = jest.fn();
const mockRefreshAccessToken = jest.fn();
const mockIsTokenExpired = jest.fn();
const mockCreateTokenCipher = jest.fn();
const mockCreateSalesforceClient = jest.fn();
const mockBuildContactFields = jest.fn();
const mockBuildPayoutActivity = jest.fn();
const mockMapContactToCollaboratorStatus = jest.fn();
const mockVerifyWebhookSignature = jest.fn();
const mockBuildAuthorizeUrl = jest.fn();
const mockCreateOAuthState = jest.fn();

class MockSalesforceError extends Error {
  constructor(message, { status = 502, code = "salesforce_error" } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

await jest.unstable_mockModule("../src/database/crm-sync-status.js", () => ({
  CRM_PROVIDER: "salesforce",
  ...crmStore,
}));

await jest.unstable_mockModule("../src/database/index.js", () => ({
  addAuditLog: mockAddAuditLog,
}));

await jest.unstable_mockModule("../src/database/contributor-status.js", () => ({
  setContributorStatus: mockSetContributorStatus,
}));

await jest.unstable_mockModule("../src/middleware/rbac.js", () => ({
  attachRole: (_req, _res, next) => next(),
  requireRole: () => (_req, _res, next) => next(),
  ROLES: ["viewer", "collaborator", "operator", "admin"],
}));

await jest.unstable_mockModule("../src/services/salesforce.js", () => ({
  DEFAULT_SALESFORCE_LOGIN_URL: "https://login.salesforce.com",
  DEFAULT_CONTACT_FIELD_MAP: { lastName: "LastName", stellarAddress: "Stellar_Address__c" },
  SalesforceError: MockSalesforceError,
  buildAuthorizeUrl: mockBuildAuthorizeUrl,
  createOAuthState: mockCreateOAuthState,
  verifyOAuthState: mockVerifyOAuthState,
  exchangeCodeForToken: mockExchangeCode,
  refreshAccessToken: mockRefreshAccessToken,
  isTokenExpired: mockIsTokenExpired,
  createTokenCipher: mockCreateTokenCipher,
  createSalesforceClient: mockCreateSalesforceClient,
  buildContactFields: mockBuildContactFields,
  buildPayoutActivity: mockBuildPayoutActivity,
  mapContactToCollaboratorStatus: mockMapContactToCollaboratorStatus,
  verifyWebhookSignature: mockVerifyWebhookSignature,
}));

const express = (await import("express")).default;
const { salesforceRouter } = await import("../src/routes/crm/salesforce.js");
const { errorHandler } = await import("../src/error-response.js");

const app = express();
app.use(express.json());
app.use("/api/v1/crm/salesforce", salesforceRouter);
app.use(errorHandler);

const connectedRow = () => ({
  contractId: CONTRACT,
  provider: "salesforce",
  instanceUrl: "https://acme.my.salesforce.com",
  orgId: "https://login.salesforce.com/id/00D/005",
  accessToken: "enc:access-token",
  refreshToken: "enc:refresh-token",
  accessTokenExpiresAt: "2030-01-01T00:00:00.000Z",
  connectedBy: ADDRESS,
  status: "connected",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

describe("Salesforce CRM routes (#939)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.SALESFORCE_CLIENT_ID = "client-id";
    process.env.SALESFORCE_CLIENT_SECRET = "client-secret";
    process.env.SALESFORCE_WEBHOOK_SECRET = "webhook-secret";

    mockIsTokenExpired.mockReturnValue(false);
    mockCreateTokenCipher.mockImplementation(() => ({
      encrypt: (value) => (value === null || value === undefined ? null : `enc:${value}`),
      decrypt: (value) => String(value ?? "").replace(/^enc:/, ""),
    }));
    mockCreateSalesforceClient.mockImplementation(() => salesforceClient);
    mockCreateOAuthState.mockReturnValue("state.token");
    mockVerifyOAuthState.mockReturnValue({ c: CONTRACT });
    mockBuildContactFields.mockImplementation((collaborator) => ({
      LastName: collaborator.name || collaborator.address,
    }));
    mockBuildPayoutActivity.mockImplementation(() => ({ Subject: "Royalty payout" }));
    mockBuildAuthorizeUrl.mockReturnValue("https://login.salesforce.com/services/oauth2/authorize?x=1");

    crmStore.getConnection.mockReturnValue(null);
    crmStore.getSyncStatus.mockReturnValue(null);
    crmStore.getContactMappingByAddress.mockReturnValue(null);
    crmStore.listContactMappings.mockReturnValue([]);
    crmStore.listCrmActivities.mockReturnValue([]);
    crmStore.listKnownCollaborators.mockReturnValue([]);
  });

  afterEach(() => {
    delete process.env.SALESFORCE_CLIENT_ID;
    delete process.env.SALESFORCE_CLIENT_SECRET;
    delete process.env.SALESFORCE_WEBHOOK_SECRET;
  });

  describe("GET /connect/url", () => {
    test("returns an authorize URL and signed state", async () => {
      const res = await request(app).get(
        `/api/v1/crm/salesforce/connect/url?contractId=${CONTRACT}&redirectUri=${encodeURIComponent(
          "https://app.example.com/crm/callback"
        )}`
      );

      expect(res.status).toBe(200);
      expect(res.body.data.authorizeUrl).toContain("salesforce.com");
      expect(res.body.data.state).toBe("state.token");
    });

    test("returns 400 for an invalid contract id", async () => {
      const res = await request(app).get(
        "/api/v1/crm/salesforce/connect/url?contractId=INVALID&redirectUri=https%3A%2F%2Fapp.example.com"
      );
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("invalid_contract_id");
    });

    test("returns 503 when OAuth credentials are not configured", async () => {
      delete process.env.SALESFORCE_CLIENT_ID;
      const res = await request(app).get(
        `/api/v1/crm/salesforce/connect/url?contractId=${CONTRACT}&redirectUri=${encodeURIComponent(
          "https://app.example.com/crm/callback"
        )}`
      );
      expect(res.status).toBe(503);
      expect(res.body.code).toBe("salesforce_not_configured");
    });
  });

  describe("POST /connect", () => {
    test("rejects an invalid OAuth state", async () => {
      mockVerifyOAuthState.mockReturnValueOnce(null);

      const res = await request(app).post("/api/v1/crm/salesforce/connect").send({
        contractId: CONTRACT,
        code: "auth-code",
        redirectUri: "https://app.example.com/crm/callback",
        state: "tampered",
      });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("invalid_oauth_state");
      expect(mockExchangeCode).not.toHaveBeenCalled();
    });

    test("exchanges the code, stores encrypted tokens, and never returns them", async () => {
      mockExchangeCode.mockResolvedValue({
        accessToken: "access-token",
        refreshToken: "refresh-token",
        instanceUrl: "https://acme.my.salesforce.com",
        identityUrl: "https://login.salesforce.com/id/00D/005",
        expiresAt: "2030-01-01T00:00:00.000Z",
      });
      crmStore.saveConnection.mockReturnValue(connectedRow());

      const res = await request(app).post("/api/v1/crm/salesforce/connect").send({
        contractId: CONTRACT,
        code: "auth-code",
        redirectUri: "https://app.example.com/crm/callback",
        state: "state.token",
        connectedBy: ADDRESS,
      });

      expect(res.status).toBe(201);
      expect(res.body.data.instanceUrl).toBe("https://acme.my.salesforce.com");
      expect(res.body.data.accessToken).toBeUndefined();
      expect(res.body.data.refreshToken).toBeUndefined();

      expect(crmStore.saveConnection).toHaveBeenCalledWith(
        expect.objectContaining({
          contractId: CONTRACT,
          accessToken: "enc:access-token",
          refreshToken: "enc:refresh-token",
        })
      );
      expect(mockAddAuditLog).toHaveBeenCalledWith(
        CONTRACT,
        "salesforce_connected",
        ADDRESS,
        expect.any(Object)
      );
    });
  });

  describe("POST /sync-collaborators", () => {
    test("returns 400 when the contract is not connected", async () => {
      const res = await request(app).post("/api/v1/crm/salesforce/sync-collaborators").send({
        contractId: CONTRACT,
        collaborators: [{ address: ADDRESS, name: "Ada Lovelace" }],
      });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("salesforce_not_connected");
    });

    test("creates Contacts for collaborators without a mapping", async () => {
      crmStore.getConnection.mockReturnValue(connectedRow());
      mockCreateContact.mockResolvedValue({ id: "003xx0000001" });
      crmStore.finishSync.mockReturnValue({ status: "completed" });

      const res = await request(app)
        .post("/api/v1/crm/salesforce/sync-collaborators")
        .send({
          contractId: CONTRACT,
          collaborators: [{ address: ADDRESS, name: "Ada Lovelace", status: "active", earnings: "15000000" }],
        });

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ total: 1, created: 1, updated: 0, failed: 0 });
      expect(mockCreateContact).toHaveBeenCalledTimes(1);
      expect(crmStore.upsertContactMapping).toHaveBeenCalledWith(
        expect.objectContaining({ address: ADDRESS, externalId: "003xx0000001", direction: "outbound" })
      );
      expect(crmStore.startSync).toHaveBeenCalledWith(CONTRACT, 1);
      expect(crmStore.finishSync).toHaveBeenCalledWith(
        CONTRACT,
        expect.objectContaining({ status: "completed" })
      );
    });

    test("updates Contacts that are already mapped", async () => {
      crmStore.getConnection.mockReturnValue(connectedRow());
      crmStore.getContactMappingByAddress.mockReturnValue({ externalId: "003existing" });
      mockUpdateContact.mockResolvedValue(null);
      crmStore.finishSync.mockReturnValue({ status: "completed" });

      const res = await request(app)
        .post("/api/v1/crm/salesforce/sync-collaborators")
        .send({ contractId: CONTRACT, collaborators: [{ address: ADDRESS }] });

      expect(res.status).toBe(200);
      expect(res.body.data.updated).toBe(1);
      expect(mockUpdateContact).toHaveBeenCalledWith("003existing", expect.any(Object));
      expect(mockCreateContact).not.toHaveBeenCalled();
    });

    test("reports partial failures without failing the whole run", async () => {
      crmStore.getConnection.mockReturnValue(connectedRow());
      mockCreateContact.mockRejectedValueOnce(new Error("boom"));
      crmStore.finishSync.mockReturnValue({ status: "completed" });

      const res = await request(app)
        .post("/api/v1/crm/salesforce/sync-collaborators")
        .send({ contractId: CONTRACT, collaborators: [{ address: ADDRESS }] });

      expect(res.status).toBe(200);
      expect(res.body.data.failed).toBe(1);
      expect(res.body.data.errors[0]).toMatchObject({ address: ADDRESS, message: "boom" });
      expect(crmStore.recordCrmActivity).toHaveBeenCalledWith(
        expect.objectContaining({ activityType: "contact_sync_failed", status: "failed" })
      );
    });

    test("falls back to known collaborators when none are supplied", async () => {
      crmStore.getConnection.mockReturnValue(connectedRow());
      crmStore.listKnownCollaborators.mockReturnValue([
        { address: ADDRESS, status: "active", earnings: "0" },
      ]);
      mockCreateContact.mockResolvedValue({ id: "003xx" });
      crmStore.finishSync.mockReturnValue({ status: "completed" });

      const res = await request(app)
        .post("/api/v1/crm/salesforce/sync-collaborators")
        .send({ contractId: CONTRACT });

      expect(res.status).toBe(200);
      expect(crmStore.listKnownCollaborators).toHaveBeenCalledWith(CONTRACT);
      expect(res.body.data.total).toBe(1);
    });
  });

  describe("GET /sync-status", () => {
    test("reports connection, sync progress, and recent activity", async () => {
      crmStore.getConnection.mockReturnValue(connectedRow());
      crmStore.getSyncStatus.mockReturnValue({
        status: "completed",
        totalCollaborators: 2,
        syncedCount: 2,
        failedCount: 0,
      });
      crmStore.listContactMappings.mockReturnValue([{ externalId: "003a", lastDirection: "outbound" }]);
      crmStore.listCrmActivities.mockReturnValue([
        { id: 1, activityType: "contact_created", payload: '{"status":"active"}' },
      ]);

      const res = await request(app).get(
        `/api/v1/crm/salesforce/sync-status?contractId=${CONTRACT}`
      );

      expect(res.status).toBe(200);
      expect(res.body.data.connected).toBe(true);
      expect(res.body.data.connection.accessToken).toBeUndefined();
      expect(res.body.data.sync.status).toBe("completed");
      expect(res.body.data.contacts.mapped).toBe(1);
      expect(res.body.data.recentActivity[0].payload).toEqual({ status: "active" });
    });

    test("returns 400 for an invalid contract id", async () => {
      const res = await request(app).get("/api/v1/crm/salesforce/sync-status?contractId=nope");
      expect(res.status).toBe(400);
    });
  });

  describe("POST /payout-activity", () => {
    test("returns 404 when the collaborator is not mapped", async () => {
      const res = await request(app).post("/api/v1/crm/salesforce/payout-activity").send({
        contractId: CONTRACT,
        address: ADDRESS,
        amount: "12.5",
      });

      expect(res.status).toBe(404);
      expect(res.body.code).toBe("contact_not_mapped");
    });

    test("creates a Salesforce activity for a mapped collaborator", async () => {
      crmStore.getContactMappingByAddress.mockReturnValue({ externalId: "003mapped" });
      crmStore.getConnection.mockReturnValue(connectedRow());
      mockCreateActivity.mockResolvedValue({ id: "00Txx" });

      const res = await request(app).post("/api/v1/crm/salesforce/payout-activity").send({
        contractId: CONTRACT,
        address: ADDRESS,
        amount: "12.5",
        transactionId: "tx-1",
      });

      expect(res.status).toBe(201);
      expect(res.body.data).toEqual({ activityId: "00Txx", contactId: "003mapped" });
      expect(mockBuildPayoutActivity).toHaveBeenCalledWith(
        expect.objectContaining({ contactId: "003mapped", address: ADDRESS })
      );
      expect(crmStore.recordCrmActivity).toHaveBeenCalledWith(
        expect.objectContaining({ activityType: "payout_activity_created" })
      );
    });
  });

  describe("POST /webhook", () => {
    test("rejects requests without a valid signature", async () => {
      mockVerifyWebhookSignature.mockReturnValue(false);

      const res = await request(app)
        .post("/api/v1/crm/salesforce/webhook")
        .send({ ContactId: "003xx", Status: "Suspended" });

      expect(res.status).toBe(401);
      expect(res.body.code).toBe("invalid_signature");
    });

    test("applies a Contact status update back onto the collaborator", async () => {
      mockVerifyWebhookSignature.mockReturnValue(true);
      crmStore.findContactMappingByExternalId.mockReturnValue({
        contractId: CONTRACT,
        address: ADDRESS,
        externalId: "003xx",
      });
      mockMapContactToCollaboratorStatus.mockReturnValue("suspended");
      mockSetContributorStatus.mockReturnValue({ status: "suspended" });

      const res = await request(app)
        .post("/api/v1/crm/salesforce/webhook")
        .send({ ContactId: "003xx", Status: "Suspended", Reason: "policy violation" });

      expect(res.status).toBe(200);
      expect(mockSetContributorStatus).toHaveBeenCalledWith(
        CONTRACT,
        ADDRESS,
        "suspended",
        expect.objectContaining({ reason: "policy violation" })
      );
      expect(crmStore.upsertContactMapping).toHaveBeenCalledWith(
        expect.objectContaining({ direction: "inbound", externalId: "003xx" })
      );
      expect(mockAddAuditLog).toHaveBeenCalledWith(
        CONTRACT,
        "crm_contact_suspended",
        null,
        expect.objectContaining({ source: "salesforce" })
      );
    });

    test("returns 404 for an unmapped Contact", async () => {
      mockVerifyWebhookSignature.mockReturnValue(true);
      crmStore.findContactMappingByExternalId.mockReturnValue(null);

      const res = await request(app)
        .post("/api/v1/crm/salesforce/webhook")
        .send({ ContactId: "003unknown", Status: "Suspended" });

      expect(res.status).toBe(404);
      expect(res.body.code).toBe("contact_not_mapped");
    });
  });
});
