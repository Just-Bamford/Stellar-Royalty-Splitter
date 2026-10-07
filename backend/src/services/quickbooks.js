/**
 * QuickBooks Online integration service — closes #940.
 *
 * Handles the OAuth 2.0 authorization code + refresh flow against Intuit,
 * authenticated calls to the QuickBooks Online Accounting API v3, creation of
 * invoices (per collaborator payout) and journal entries (fee / royalty pool
 * transfers), and receipt of QuickBooks webhooks (invoice paid → mark the sync
 * item confirmed in SRS).
 *
 * Environment:
 *   QUICKBOOKS_CLIENT_ID               Intuit OAuth app client id
 *   QUICKBOOKS_CLIENT_SECRET           Intuit OAuth app client secret
 *   QUICKBOOKS_REALM_ID                Default company id when none stored
 *   QUICKBOOKS_REDIRECT_URI            OAuth redirect URI (authorization_code flow)
 *   QUICKBOOKS_WEBHOOK_VERIFIER_TOKEN  HMAC-SHA256 token used by Intuit webhooks
 *
 * Scopes requested: com.intuit.quickbooks.accounting (invoices + journal entries).
 */

import crypto from "crypto";
import logger from "../logger.js";
import {
  createQuickBooksOAuthState,
  getQuickBooksTokens,
  saveQuickBooksConnection,
} from "../database/accounting-sync.js";

export const QUICKBOOKS_SCOPE = "com.intuit.quickbooks.accounting";
export const QUICKBOOKS_AUTHORIZE_BASE = "https://appcenter.intuit.com/connect/oauth2";
export const QUICKBOOKS_TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
export const QUICKBOOKS_API_BASE = "https://quickbooks.api.intuit.com/v3";

function clientConfig() {
  const clientId = process.env.QUICKBOOKS_CLIENT_ID;
  const clientSecret = process.env.QUICKBOOKS_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw Object.assign(
      new Error(
        "QuickBooks is not configured: QUICKBOOKS_CLIENT_ID and QUICKBOOKS_CLIENT_SECRET must be set"
      ),
      { status: 503, code: "quickbooks_not_configured" }
    );
  }
  return { clientId, clientSecret };
}

function redirectUri() {
  return (
    process.env.QUICKBOOKS_REDIRECT_URI ??
    "http://localhost:3001/api/v1/accounting/quickbooks/callback"
  );
}

/** Company id for a given realm (explicit > env default). */
function realmIdFrom(connection, explicit) {
  return explicit ?? connection?.realm_id ?? process.env.QUICKBOOKS_REALM_ID ?? null;
}

// ─── OAuth ─────────────────────────────────────────────────────────────────────

/**
 * Build the authorization URL that takes an admin to Intuit's consent screen.
 * Persists a one-time state token for CSRF validation on callback.
 */
export async function buildAuthUrl() {
  clientConfig();
  const state = crypto.randomBytes(24).toString("hex");
  createQuickBooksOAuthState(state);
  const params = new URLSearchParams({
    client_id: process.env.QUICKBOOKS_CLIENT_ID,
    response_type: "code",
    scope: QUICKBOOKS_SCOPE,
    redirect_uri: redirectUri(),
    state,
  });
  return { authUrl: `${QUICKBOOKS_AUTHORIZE_BASE}?${params.toString()}`, state };
}

/**
 * Exchange an authorization code (from the OAuth callback) for access +
 * refresh tokens and persist the connection.
 *
 * @param {string} code     Intuit-provided authorization code
 * @param {string} realmId  Intuit company id echoed by the callback
 */
export async function exchangeCodeForToken({ code, realmId }) {
  const { clientId, clientSecret } = clientConfig();
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(),
  });

  const token = await tokenRequest(clientId, clientSecret, body);
  const expiresIn = (token.expires_in && parseInt(token.expires_in, 10)) || 3600;
  const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

  const saved = saveQuickBooksConnection({
    realmId: realmId ?? token.realmId ?? null,
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAt,
    status: "connected",
    connectedAt: new Date().toISOString(),
  });

  logger.info("QuickBooks company connected", {
    realmId: saved.realm_id ?? realmId ?? token.realmId,
  });
  return {
    realmId: saved.realm_id ?? token.realmId ?? realmId ?? null,
    expiresAt,
  };
}

async function tokenRequest(clientId, clientSecret, body) {
  const res = await fetch(QUICKBOOKS_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
    },
    body: body.toString(),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    logger.error("QuickBooks OAuth token request failed", {
      status: res.status,
      detail: detail.slice(0, 500),
    });
    throw Object.assign(new Error("QuickBooks OAuth token exchange failed"), {
      status: 502,
      code: "quickbooks_oauth_failed",
      detail: detail.slice(0, 300),
    });
  }
  return res.json();
}

/**
 * Refresh the stored access token using the persisted refresh token.
 * Returns updated connection tokens.
 */
export async function refreshAccessToken() {
  const connection = getQuickBooksTokens();
  if (!connection?.refresh_token) {
    throw Object.assign(new Error("No QuickBooks refresh token stored"), {
      status: 401,
      code: "quickbooks_not_connected",
    });
  }
  const { clientId, clientSecret } = clientConfig();
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: connection.refresh_token,
  });

  const token = await tokenRequest(clientId, clientSecret, body);
  const expiresIn = (token.expires_in && parseInt(token.expires_in, 10)) || 3600;
  const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

  saveQuickBooksConnection({
    realmId: connection.realm_id,
    accessToken: token.access_token,
    refreshToken: token.refresh_token ?? connection.refresh_token,
    expiresAt,
    status: "connected",
  });

  logger.info("QuickBooks access token refreshed", { realmId: connection.realm_id });
  const updated = getQuickBooksTokens();
  return {
    accessToken: updated?.access_token,
    expiresAt: updated?.token_expires_at,
  };
}

/**
 * Return a valid access token, refreshing first when expired or absent.
 */
export async function getAccessToken() {
  const connection = getQuickBooksTokens();
  if (!connection?.access_token) {
    throw Object.assign(new Error("QuickBooks is not connected"), {
      status: 401,
      code: "quickbooks_not_connected",
    });
  }
  const expiresAt = connection.token_expires_at ? new Date(connection.token_expires_at).getTime() : 0;
  if (expiresAt - Date.now() > 60_000) {
    return connection.access_token;
  }
  const refreshed = await refreshAccessToken();
  return refreshed.accessToken;
}

// ─── Authenticated API client ──────────────────────────────────────────────────

/**
 * Perform an authenticated request against the QuickBooks accounting API.
 * Retries once with a freshly refreshed token on 401.
 */
export async function qbRequest(path, { method = "GET", body = null, realmId = null } = {}) {
  const connection = getQuickBooksTokens();
  const realm = realmIdFrom(connection, realmId);
  if (!realm) {
    throw Object.assign(new Error("No QuickBooks company (realm) available"), {
      status: 409,
      code: "quickbooks_no_realm",
    });
  }
  const accessToken = await getAccessToken();

  const call = async (token) => {
    const res = await fetch(`${QUICKBOOKS_API_BASE}/company/${realm}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return res;
  };

  let res = await call(accessToken);

  if (res.status === 401) {
    // Access token may have been rotated / revoked — refresh once and retry.
    await refreshAccessToken();
    res = await call((await getAccessToken()));
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    logger.error("QuickBooks API request failed", {
      path,
      method,
      status: res.status,
      detail: detail.slice(0, 500),
    });
    throw Object.assign(new Error(`QuickBooks API ${method} ${path} failed (${res.status})`), {
      status: 502,
      code: "quickbooks_api_error",
      detail: detail.slice(0, 300),
    });
  }

  return res.json();
}

/**
 * Convert a raw amount string into an Intuit-compatible decimal.
 */
export function normalizeAmount(amount) {
  const num = Number(amount);
  if (!Number.isFinite(num)) return "0.00";
  return num.toFixed(2);
}

/**
 * Create a QuickBooks invoice for a single collaborator payout.
 * QuickBooks auto-creates the customer when only a `name` is supplied.
 *
 * @param {{ recipient: string, amount: string, memo: string, realmId: string|null,
 *           invoiceNumber: string|null }} params
 * @returns {Promise<{ id: string, docNumber: string }>}
 */
export async function createInvoice({ recipient, amount, memo = "", realmId = null, invoiceNumber = null }) {
  const payload = {
    CustomerRef: { name: `Stellar Payout (${recipient})` },
    Line: [
      {
        Amount: normalizeAmount(amount),
        Description: memo || `Stellar royalty payout to ${recipient}`,
        DetailType: "SalesItemLineDetail",
        SalesItemLineDetail: {
          ItemRef: { name: "Royalty Payouts" },
        },
      },
    ],
  };
  if (invoiceNumber) payload.DocNumber = String(invoiceNumber);

  const created = await qbRequest("/invoice?minorversion=65", {
    method: "POST",
    body: payload,
    realmId,
  });
  return { id: created.Invoice?.Id ?? created.Id, docNumber: created.Invoice?.DocNumber ?? null };
}

/**
 * Create a QuickBooks journal entry representing a fee / royalty pool transfer
 * for a distribution. Debits the royalty pool, credits the distribution fees
 * account (both auto-created by name when only a `name` is supplied).
 *
 * @param {{ amount: string, memo: string, realmId: string|null }} params
 * @returns {Promise<{ id: string }>}
 */
export async function createJournalEntry({ amount, memo = "", realmId = null }) {
  const normalized = normalizeAmount(amount);
  const payload = {
    PrivateNote: `Stellar royalty pool transfer — ${memo || "distribution"}`,
    Line: [
      {
        Description: "Royalty pool transfer (debit)",
        Amount: normalized,
        JournalEntryLineDetail: {
          PostingType: "Debit",
          AccountRef: { name: "Royalty Pool" },
        },
      },
      {
        Description: "Distribution fees / pool settlement (credit)",
        Amount: normalized,
        JournalEntryLineDetail: {
          PostingType: "Credit",
          AccountRef: { name: "Distribution Fees" },
        },
      },
    ],
  };

  const created = await qbRequest("/journalentry?minorversion=65", {
    method: "POST",
    body: payload,
    realmId,
  });
  return { id: created.JournalEntry?.Id ?? created.Id };
}

// ─── Webhooks ─────────────────────────────────────────────────────────────────

/**
 * Verify an Intuit webhook signature. The raw request body is HMAC-SHA256
 * signed with the webhook verifier token (`intuit-signature` header). Returns
 * true when no token is configured (dev mode) so integrations can be tested.
 */
export function verifyWebhookSignature(rawBody, signature) {
  const token = process.env.QUICKBOOKS_WEBHOOK_VERIFIER_TOKEN;
  if (!token) {
    logger.warn(
      "QUICKBOOKS_WEBHOOK_VERIFIER_TOKEN not set; skipping webhook signature verification"
    );
    return true;
  }
  if (!signature) return false;
  const expected = crypto.createHmac("sha256", token).update(rawBody ?? "").digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

/**
 * Extract the { type, id, operation, realmId } entity notifications from a
 * QuickBooks webhook payload.
 */
export function parseWebhookPayload(payload) {
  const entities = [];
  for (const notification of payload?.eventNotifications ?? []) {
    const realmId = notification.realmId ?? null;
    for (const entity of notification.dataChangeEvent?.entities ?? []) {
      entities.push({
        type: entity.type,
        id: entity.id,
        operation: entity.operation,
        realmId,
        lastUpdated: entity.lastUpdated ?? null,
      });
    }
  }
  return entities;
}

/**
 * Given a QuickBooks invoice id, fetch it and report whether it has been fully
 * paid (Balance === 0).
 */
export async function isInvoicePaid(invoiceId, realmId = null) {
  const data = await qbRequest(`/invoice/${invoiceId}?minorversion=65`, { realmId });
  const invoice = data.Invoice ?? data;
  const balance = Number(invoice.Balance ?? 0);
  return balance === 0;
}