import { jest, describe, test, expect, beforeEach } from "@jest/globals";
import crypto from "crypto";

const mockGetQuickBooksTokens = jest.fn();
const mockSaveQuickBooksConnection = jest.fn();
const mockUpdateQuickBooksAccessToken = jest.fn();
const mockCreateQuickBooksOAuthState = jest.fn();

await jest.unstable_mockModule("../src/database/accounting-sync.js", () => ({
  saveQuickBooksConnection: mockSaveQuickBooksConnection,
  getQuickBooksTokens: mockGetQuickBooksTokens,
  updateQuickBooksAccessToken: mockUpdateQuickBooksAccessToken,
  createQuickBooksOAuthState: mockCreateQuickBooksOAuthState,
  getQuickBooksConnection: jest.fn(),
  setQuickBooksConnectionStatus: jest.fn(),
}));

const {
  buildAuthUrl,
  exchangeCodeForToken,
  refreshAccessToken,
  getAccessToken,
  qbRequest,
  createInvoice,
  createJournalEntry,
  verifyWebhookSignature,
  parseWebhookPayload,
  isInvoicePaid,
  normalizeAmount,
  QUICKBOOKS_TOKEN_URL,
  QUICKBOOKS_API_BASE,
} = await import("../src/services/quickbooks.js");

// ── Helpers ───────────────────────────────────────────────────────────────────

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

function validFetchMock() {
  return jest.fn(async (url, options) => {
    if (String(url) === QUICKBOOKS_TOKEN_URL) {
      return jsonResponse({
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 3600,
      });
    }
    return jsonResponse({});
  });
}

describe("QuickBooks service (#940)", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.QUICKBOOKS_CLIENT_ID = "client-abc";
    process.env.QUICKBOOKS_CLIENT_SECRET = "secret-abc";
    process.env.QUICKBOOKS_REALM_ID = "88888";
    global.fetch = validFetchMock();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe("OAuth helpers", () => {
    test("buildAuthUrl generates an Intuit consent URL with a persisted state token", async () => {
      mockCreateQuickBooksOAuthState.mockReturnValue("state-foo");
      const { authUrl, state } = await buildAuthUrl();

      expect(state).toBeDefined();
      expect(authUrl).toContain("client_id=client-abc");
      expect(authUrl).toContain("response_type=code");
      expect(authUrl).toContain("com.intuit.quickbooks.accounting");
      expect(authUrl).toContain(`state=${state}`);
      expect(mockCreateQuickBooksOAuthState).toHaveBeenCalledWith(state);
    });

    test("buildAuthUrl throws when QuickBooks env vars are missing", async () => {
      delete process.env.QUICKBOOKS_CLIENT_ID;
      await expect(buildAuthUrl()).rejects.toMatchObject({ status: 503, code: "quickbooks_not_configured" });
    });

    test("exchangeCodeForToken posts the code and persists tokens with an expiry", async () => {
      global.fetch = jest.fn(async (url, options) => {
        expect(String(url)).toBe(QUICKBOOKS_TOKEN_URL);
        const body = options.body.toString();
        expect(body).toContain("grant_type=authorization_code");
        expect(options.headers.Authorization).toContain("Basic ");
        return jsonResponse({ access_token: "tok-1", refresh_token: "ref-1", expires_in: 3600 });
      });
      mockSaveQuickBooksConnection.mockImplementation((c) => ({ ...c, id: 1 }));

      const result = await exchangeCodeForToken({ code: "code-1", realmId: "123" });

      expect(mockSaveQuickBooksConnection).toHaveBeenCalledWith(
        expect.objectContaining({
          realmId: "123",
          accessToken: "tok-1",
          refreshToken: "ref-1",
          status: "connected",
        })
      );
      expect(result.realmId).toBe("123");
      expect(result.expiresAt).toBeDefined();
    });

    test("refreshAccessToken uses the stored refresh token and returns a fresh access token", async () => {
      mockGetQuickBooksTokens
        .mockReturnValueOnce({ realm_id: "123", refresh_token: "stored-refresh" })
        .mockReturnValueOnce({ realm_id: "123", access_token: "fresh", refresh_token: "new-refresh" });
      mockSaveQuickBooksConnection.mockImplementation((c) => ({ ...c, id: 1 }));
      global.fetch = jest.fn(async (_url, options) => {
        expect(options.body.toString()).toContain("grant_type=refresh_token");
        expect(options.body.toString()).toContain("refresh_token=stored-refresh");
        return jsonResponse({ access_token: "fresh", refresh_token: "new-refresh", expires_in: 3600 });
      });

      const result = await refreshAccessToken();
      expect(result.accessToken).toBe("fresh");
    });

    test("getAccessToken refreshes when the stored token is expired", async () => {
      const tokenState = {
        realm_id: "123",
        access_token: "old",
        refresh_token: "stored-refresh",
        token_expires_at: new Date(Date.now() - 1000).toISOString(),
      };
      mockGetQuickBooksTokens.mockImplementation(() => ({ ...tokenState }));
      mockSaveQuickBooksConnection.mockImplementation((c) => ({ ...c, id: 1 }));
      global.fetch = jest.fn(async (url) => {
        if (String(url) === QUICKBOOKS_TOKEN_URL) {
          tokenState.access_token = "new-access";
          tokenState.token_expires_at = new Date(Date.now() + 3600_000).toISOString();
          return jsonResponse({ access_token: "new-access", refresh_token: "ref", expires_in: 3600 });
        }
        return jsonResponse({});
      });

      const token = await getAccessToken();
      expect(token).toBe("new-access");
    });

    test("getAccessToken throws when no connection exists", async () => {
      mockGetQuickBooksTokens.mockReturnValue(null);
      await expect(getAccessToken()).rejects.toMatchObject({ status: 401, code: "quickbooks_not_connected" });
    });
  });

  describe("API client", () => {
    test("normalizeAmount formats numeric strings to two decimals", () => {
      expect(normalizeAmount("1000")).toBe("1000.00");
      expect(normalizeAmount("600.5")).toBe("600.50");
      expect(normalizeAmount("not-a-number")).toBe("0.00");
    });

    test("createInvoice posts the correct invoice payload and returns the QB id", async () => {
      mockGetQuickBooksTokens.mockReturnValue({
        realm_id: "123", access_token: "tok", token_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      });
      global.fetch = jest.fn(async (url, options) => {
        expect(String(url)).toContain(`${QUICKBOOKS_API_BASE}/company/123/invoice`);
        const payload = JSON.parse(options.body);
        expect(payload.CustomerRef.name).toContain("GABC");
        expect(payload.Line[0].Amount).toBe("600.00");
        expect(payload.DocNumber).toBe("SRS-42-GABC12");
        return jsonResponse({ Invoice: { Id: "302", DocNumber: "SRS-42-GABC12" } });
      });

      const result = await createInvoice({
        recipient: "GABC",
        amount: "600",
        realmId: "123",
        invoiceNumber: "SRS-42-GABC12",
      });
      expect(result).toEqual({ id: "302", docNumber: "SRS-42-GABC12" });
    });

    test("createJournalEntry posts balanced debit/credit lines", async () => {
      mockGetQuickBooksTokens.mockReturnValue({
        realm_id: "123", access_token: "tok", token_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      });
      global.fetch = jest.fn(async (url, options) => {
        expect(String(url)).toContain("/journalentry");
        const payload = JSON.parse(options.body);
        expect(payload.Line).toHaveLength(2);
        expect(payload.Line[0].JournalEntryLineDetail.PostingType).toBe("Debit");
        expect(payload.Line[1].JournalEntryLineDetail.PostingType).toBe("Credit");
        expect(payload.Line[0].Amount).toBe("1000.00");
        return jsonResponse({ JournalEntry: { Id: "7001" } });
      });

      const result = await createJournalEntry({ amount: "1000", realmId: "123" });
      expect(result.id).toBe("7001");
    });

    test("qbRequest retries once with a refreshed token on 401", async () => {
      const tokenState = {
        realm_id: "123",
        access_token: "expired",
        refresh_token: "stored-refresh",
        token_expires_at: new Date(Date.now() - 5000).toISOString(),
      };
      mockGetQuickBooksTokens.mockImplementation(() => ({ ...tokenState }));
      mockSaveQuickBooksConnection.mockImplementation((c) => ({ ...c, id: 1 }));
      let calls = 0;
      global.fetch = jest.fn(async (url) => {
        if (String(url) === QUICKBOOKS_TOKEN_URL) {
          tokenState.access_token = "fresh-token";
          tokenState.token_expires_at = new Date(Date.now() + 3600_000).toISOString();
          return jsonResponse({ access_token: "fresh-token", refresh_token: "ref", expires_in: 3600 });
        }
        calls += 1;
        if (calls === 1) return jsonResponse({ fault: { type: "auth" } }, 401);
        return jsonResponse({ Invoice: { Id: "302" } });
      });

      const result = await qbRequest("/invoice/302?minorversion=65", { realmId: "123" });
      expect(result.Invoice.Id).toBe("302");
      expect(calls).toBe(2);
    });

    test("qbRequest throws a structured error on a non-2xx response", async () => {
      mockGetQuickBooksTokens.mockReturnValue({
        realm_id: "123", access_token: "tok", token_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      });
      global.fetch = jest.fn(async () => jsonResponse({}, 400));
      await expect(qbRequest("/invoice", { method: "POST", realmId: "123" })).rejects.toMatchObject({
        status: 502,
        code: "quickbooks_api_error",
      });
    });

    test("isInvoicePaid resolves true when Balance is zero", async () => {
      mockGetQuickBooksTokens.mockReturnValue({
        realm_id: "123", access_token: "tok", token_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      });
      global.fetch = jest.fn(async () => jsonResponse({ Invoice: { Id: "302", Balance: 0 } }));
      await expect(isInvoicePaid("302", "123")).resolves.toBe(true);
    });
  });

  describe("Webhook verification", () => {
    test("verifyWebhookSignature accepts a valid HMAC-SHA256 signature", () => {
      process.env.QUICKBOOKS_WEBHOOK_VERIFIER_TOKEN = "verifier-secret";
      const body = '{"eventNotifications":[]}';
      const sig = crypto.createHmac("sha256", "verifier-secret").update(body).digest("hex");
      expect(verifyWebhookSignature(body, sig)).toBe(true);
    });

    test("verifyWebhookSignature rejects an invalid signature", () => {
      process.env.QUICKBOOKS_WEBHOOK_VERIFIER_TOKEN = "verifier-secret";
      expect(verifyWebhookSignature('{"a":1}', "deadbeef")).toBe(false);
    });

    test("parseWebhookPayload flattens entity notifications", () => {
      const entities = parseWebhookPayload({
        eventNotifications: [
          {
            realmId: "123",
            dataChangeEvent: {
              entities: [
                { id: "1", type: "Invoice", name: "invoice", operation: "Update" },
                { id: "2", type: "Payment", name: "payment", operation: "Create" },
              ],
            },
          },
        ],
      });
      expect(entities).toHaveLength(2);
      expect(entities[0]).toMatchObject({ type: "Invoice", id: "1", operation: "Update", realmId: "123" });
    });
  });
});