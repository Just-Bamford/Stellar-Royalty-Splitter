/**
 * Unit tests for the Salesforce service helpers (#939).
 *
 * These tests exercise the pure mapping/OAuth/signature helpers plus the
 * `SalesforceClient` request layer against a stubbed `fetch`, so they need no
 * network, database, or environment.
 */
import { jest, describe, test, expect } from "@jest/globals";
import crypto from "crypto";

import {
  DEFAULT_SALESFORCE_LOGIN_URL,
  SalesforceError,
  SalesforceClient,
  buildAuthorizeUrl,
  createOAuthState,
  verifyOAuthState,
  exchangeCodeForToken,
  refreshAccessToken,
  isTokenExpired,
  normalizeTokenResponse,
  createTokenCipher,
  createSalesforceClient,
  buildContactFields,
  buildPayoutActivity,
  splitContactName,
  stroopsToAmount,
  normalizeCollaboratorStatus,
  mapContactToCollaboratorStatus,
  escapeSoqlString,
  verifyWebhookSignature,
} from "../src/services/salesforce.js";

const ADDRESS = "GAPTAQKSMN2ILFVHXDE5V274BUPC6QCRMJZYJFNGW7ENT2X3BQOS4M3C";

function makeRes(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () =>
      body === undefined || body === null
        ? ""
        : typeof body === "string"
          ? body
          : JSON.stringify(body),
  };
}

describe("collaborator → Contact mapping", () => {
  test("maps name, address, earnings, and status to Contact fields", () => {
    const fields = buildContactFields({
      address: ADDRESS,
      name: "Ada Lovelace",
      email: "ada@example.com",
      status: "suspended",
      earnings: "15000000",
    });

    expect(fields).toMatchObject({
      FirstName: "Ada",
      LastName: "Lovelace",
      Email: "ada@example.com",
      Collaborator_Status__c: "suspended",
      Stellar_Address__c: ADDRESS,
      Total_Earnings__c: 1.5,
    });
    expect(fields.Description).toContain(ADDRESS);
    expect(fields.MailingStreet).toBeUndefined();
  });

  test("falls back to a shortened wallet label when no name is present", () => {
    const fields = buildContactFields({ address: ADDRESS, status: "active" });
    expect(fields.LastName).toContain("…");
    expect(fields.FirstName).toBeUndefined();
  });

  test("respects a custom field map and never emits undefined fields", () => {
    const fields = buildContactFields(
      { address: ADDRESS, name: "Solo" },
      { lastName: "Custom_Last__c", stellarAddress: "Wallet__c" }
    );
    expect(fields).toEqual({ Custom_Last__c: "Solo", Wallet__c: ADDRESS });
  });

  test("splitContactName handles single-token and explicit names", () => {
    expect(splitContactName({ name: "Cher" })).toEqual({ LastName: "Cher" });
    expect(splitContactName({ firstName: "Ada", lastName: "Lovelace" })).toEqual({
      FirstName: "Ada",
      LastName: "Lovelace",
    });
    expect(splitContactName({ name: "Ada King Lovelace" })).toEqual({
      FirstName: "Ada King",
      LastName: "Lovelace",
    });
  });
});

describe("numeric + status helpers", () => {
  test("stroopsToAmount converts stroops to a 2dp decimal", () => {
    expect(stroopsToAmount("15000000")).toBe(1.5);
    expect(stroopsToAmount("123456789")).toBe(12.34);
    expect(stroopsToAmount("0")).toBe(0);
    expect(stroopsToAmount("not-a-number")).toBeNull();
    expect(stroopsToAmount(null)).toBeNull();
  });

  test("normalizeCollaboratorStatus maps common Salesforce values", () => {
    expect(normalizeCollaboratorStatus("Active")).toBe("active");
    expect(normalizeCollaboratorStatus("On Hold")).toBe("suspended");
    expect(normalizeCollaboratorStatus("Inactive")).toBe("deactivated");
    expect(normalizeCollaboratorStatus("")).toBeNull();
    expect(normalizeCollaboratorStatus("mystery")).toBeNull();
  });

  test("mapContactToCollaboratorStatus reads the custom status field", () => {
    expect(mapContactToCollaboratorStatus({ Collaborator_Status__c: "Suspended" })).toBe("suspended");
    expect(mapContactToCollaboratorStatus({ Status: "active" })).toBe("active");
  });

  test("escapeSoqlString escapes quotes and backslashes", () => {
    expect(escapeSoqlString("O'Brien")).toBe("O\\'Brien");
    expect(escapeSoqlString("50%")).toBe("50\\%");
  });
});

describe("OAuth helpers", () => {
  const secret = "client-secret";

  test("buildAuthorizeUrl includes the expected query parameters", () => {
    const url = buildAuthorizeUrl({
      contractId: "C1",
      redirectUri: "https://app.example.com/cb",
      state: "abc",
      clientId: "cid",
    });
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe(`${DEFAULT_SALESFORCE_LOGIN_URL}/services/oauth2/authorize`);
    expect(parsed.searchParams.get("client_id")).toBe("cid");
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("state")).toBe("abc");
    expect(parsed.searchParams.get("crm_contract_id")).toBe("C1");
  });

  test("buildAuthorizeUrl rejects a missing client id", () => {
    expect(() => buildAuthorizeUrl({ redirectUri: "https://x", clientId: null })).toThrow(SalesforceError);
  });

  test("createOAuthState / verifyOAuthState round-trip", () => {
    const state = createOAuthState("C1", secret, { now: 1_000 });
    const verified = verifyOAuthState(state, secret, { now: 1_000 });
    expect(verified).toMatchObject({ c: "C1" });
  });

  test("verifyOAuthState rejects tampered and expired states", () => {
    const state = createOAuthState("C1", secret, { ttlMs: 1000, now: 1_000 });
    expect(verifyOAuthState(`${state}x`, secret, { now: 1_000 })).toBeNull();
    expect(verifyOAuthState(state, "wrong-secret", { now: 1_000 })).toBeNull();
    expect(verifyOAuthState(state, secret, { now: 10_000 })).toBeNull();
  });

  test("exchangeCodeForToken posts the code and normalizes the response", async () => {
    const fetchImpl = jest.fn(async () =>
      makeRes(200, {
        access_token: "at",
        refresh_token: "rt",
        instance_url: "https://acme.my.salesforce.com",
        expires_in: 3600,
      })
    );

    const tokens = await exchangeCodeForToken({
      code: "code-1",
      redirectUri: "https://app.example.com/cb",
      clientId: "cid",
      clientSecret: "secret",
      fetchImpl,
    });

    expect(tokens).toMatchObject({
      accessToken: "at",
      refreshToken: "rt",
      instanceUrl: "https://acme.my.salesforce.com",
      expiresIn: 3600,
    });
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toContain("/services/oauth2/token");
    expect(options.method).toBe("POST");
    expect(options.body).toContain("grant_type=authorization_code");
  });

  test("exchangeCodeForToken surfaces Salesforce errors", async () => {
    const fetchImpl = jest.fn(async () =>
      makeRes(400, { error: "invalid_grant", error_description: "bad code" })
    );

    await expect(
      exchangeCodeForToken({ code: "c", redirectUri: "https://x", clientId: "cid", clientSecret: "s", fetchImpl })
    ).rejects.toMatchObject({ code: "salesforce_oauth_failed", status: 401 });
  });

  test("refreshAccessToken requires a refresh token and maps failures", async () => {
    await expect(refreshAccessToken({ clientId: "cid", clientSecret: "s" })).rejects.toMatchObject({
      code: "salesforce_reconnect_required",
    });

    const fetchImpl = jest.fn(async () => makeRes(400, { error: "invalid_grant" }));
    await expect(
      refreshAccessToken({ refreshToken: "rt", clientId: "cid", clientSecret: "s", fetchImpl })
    ).rejects.toMatchObject({ code: "salesforce_reconnect_required" });
  });

  test("isTokenExpired respects the clock skew window", () => {
    const now = Date.parse("2026-01-01T00:00:00.000Z");
    expect(isTokenExpired("2026-01-01T01:00:00.000Z", { now })).toBe(false);
    expect(isTokenExpired("2025-12-31T23:59:30.000Z", { now })).toBe(true);
    expect(isTokenExpired(null, { now })).toBe(false);
    expect(isTokenExpired("nonsense", { now })).toBe(false);
  });

  test("normalizeTokenResponse omits expiry when Salesforce does not send one", () => {
    const tokens = normalizeTokenResponse({ access_token: "at" });
    expect(tokens.expiresAt).toBeNull();
    expect(tokens.expiresIn).toBeNull();
  });
});

describe("token encryption", () => {
  test("round-trips values and rejects the wrong key", () => {
    const cipher = createTokenCipher("secret-key");
    const encrypted = cipher.encrypt("refresh-token");
    expect(encrypted).toMatch(/^v1:/);
    expect(cipher.decrypt(encrypted)).toBe("refresh-token");

    const other = createTokenCipher("different-key");
    expect(() => other.decrypt(encrypted)).toThrow();
  });

  test("decrypt tolerates plaintext values", () => {
    const cipher = createTokenCipher("secret-key");
    expect(cipher.decrypt("plain-token")).toBe("plain-token");
  });

  test("createSalesforceClient decrypts the stored access token", () => {
    const cipher = createTokenCipher("secret-key");
    const client = createSalesforceClient(
      { instanceUrl: "https://acme.my.salesforce.com", accessToken: cipher.encrypt("at") },
      { tokenCipher: cipher }
    );
    expect(client.accessToken).toBe("at");
  });
});

describe("webhook signature verification", () => {
  const secret = "webhook-secret";
  const rawBody = Buffer.from(JSON.stringify({ ContactId: "003xx", Status: "Suspended" }));

  test("accepts a valid sha256 signature and rejects a bad one", () => {
    const signature = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
    expect(verifyWebhookSignature({ secret, signature, rawBody })).toBe(true);
    expect(verifyWebhookSignature({ secret, signature: `sha256=${signature}`, rawBody })).toBe(true);
    expect(verifyWebhookSignature({ secret, signature: "deadbeef", rawBody })).toBe(false);
    expect(verifyWebhookSignature({ secret, signature, rawBody: Buffer.from("{}") })).toBe(false);
    expect(verifyWebhookSignature({ secret: null, signature, rawBody })).toBe(false);
  });
});

describe("SalesforceClient", () => {
  const base = "https://acme.my.salesforce.com";

  test("createContact POSTs to the Contact sObject with the bearer token", async () => {
    const fetchImpl = jest.fn(async () => makeRes(201, { id: "003xx", success: true }));
    const client = new SalesforceClient({ instanceUrl: base, accessToken: "at", fetchImpl });

    const created = await client.createContact({ LastName: "Lovelace" });

    expect(created.id).toBe("003xx");
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${base}/services/data/v60.0/sobjects/Contact`);
    expect(options.method).toBe("POST");
    expect(options.headers.authorization).toBe("Bearer at");
    expect(JSON.parse(options.body)).toEqual({ LastName: "Lovelace" });
  });

  test("updateContact uses PATCH on the existing Contact id", async () => {
    const fetchImpl = jest.fn(async () => makeRes(204, null));
    const client = new SalesforceClient({ instanceUrl: base, accessToken: "at", fetchImpl });

    const result = await client.updateContact("003xx", { Collaborator_Status__c: "suspended" });

    expect(result).toBeNull();
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${base}/services/data/v60.0/sobjects/Contact/003xx`);
    expect(options.method).toBe("PATCH");
  });

  test("query sends SOQL through the q parameter", async () => {
    const fetchImpl = jest.fn(async () => makeRes(200, { totalSize: 0, records: [] }));
    const client = new SalesforceClient({ instanceUrl: base, accessToken: "at", fetchImpl });

    await client.findByStellarAddress(ADDRESS);

    const [url] = fetchImpl.mock.calls[0];
    const soql = new URL(url).searchParams.get("q");
    expect(soql).toBe(
      `SELECT Id, Name FROM Contact WHERE Stellar_Address__c = '${ADDRESS}' LIMIT 1`
    );
  });

  test("maps 401 responses to a reconnect-required error", async () => {
    const fetchImpl = jest.fn(async () => makeRes(401, [{ message: "Session expired" }]));
    const client = new SalesforceClient({ instanceUrl: base, accessToken: "at", fetchImpl });

    await expect(client.getContact("003xx")).rejects.toMatchObject({
      code: "salesforce_reconnect_required",
      status: 401,
      message: "Session expired",
    });
  });

  test("wraps network failures", async () => {
    const fetchImpl = jest.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const client = new SalesforceClient({ instanceUrl: base, accessToken: "at", fetchImpl });

    await expect(client.getContact("003xx")).rejects.toMatchObject({
      code: "salesforce_network_error",
    });
  });

  test("requires instanceUrl and accessToken", () => {
    expect(() => new SalesforceClient({ accessToken: "at" })).toThrow(SalesforceError);
    expect(() => new SalesforceClient({ instanceUrl: base })).toThrow(SalesforceError);
  });
});

describe("buildPayoutActivity", () => {
  test("links the activity to the Contact and includes payout details", () => {
    const activity = buildPayoutActivity({
      contactId: "003xx",
      address: ADDRESS,
      amount: "12.5",
      currency: "XLM",
      transactionId: "tx-1",
    });
    expect(activity.WhoId).toBe("003xx");
    expect(activity.Subject).toContain("12.5 XLM");
    expect(activity.Description).toContain("tx-1");
    expect(activity.Status).toBe("Completed");
  });
});
