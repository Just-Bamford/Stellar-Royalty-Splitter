/**
 * Salesforce CRM integration service (#939).
 *
 * Framework-free wrapper around the Salesforce REST API plus the small set of
 * pure helpers used to map Stellar Royalty Splitter collaborators onto
 * Salesforce Contacts and back. Nothing here touches the database or Express,
 * so the whole module is unit-testable by injecting a fake `fetchImpl`.
 *
 * OAuth tokens are encrypted at rest (AES-256-GCM) before they are handed to
 * the persistence layer. The key is derived from `SALESFORCE_CLIENT_SECRET`
 * (or an explicit `SALESFORCE_TOKEN_ENCRYPTION_KEY`), which means rotating the
 * connected app secret invalidates stored tokens and requires a reconnect.
 *
 * Required environment:
 *   SALESFORCE_CLIENT_ID       — connected app consumer key
 *   SALESFORCE_CLIENT_SECRET   — connected app consumer secret
 * Optional:
 *   SALESFORCE_LOGIN_URL       — defaults to https://login.salesforce.com
 *   SALESFORCE_API_VERSION     — defaults to v60.0
 *   SALESFORCE_WEBHOOK_SECRET  — HMAC secret for inbound contact webhooks
 *   SALESFORCE_CONTACT_FIELDS  — JSON override for the Contact field mapping
 */
import crypto from "crypto";

export const SALESFORCE_PROVIDER = "salesforce";
export const DEFAULT_SALESFORCE_LOGIN_URL = "https://login.salesforce.com";
export const DEFAULT_SALESFORCE_API_VERSION = "v60.0";
export const DEFAULT_SALESFORCE_SCOPES = ["api", "refresh_token", "offline_access"];

/**
 * Maps logical collaborator attributes onto Salesforce Contact field API
 * names. Override individual entries with `SALESFORCE_CONTACT_FIELDS`.
 *
 * The `__c` custom fields are created out-of-band by the Salesforce admin —
 * account setup is explicitly out of scope for #939.
 */
export const DEFAULT_CONTACT_FIELD_MAP = {
  firstName: "FirstName",
  lastName: "LastName",
  email: "Email",
  phone: "Phone",
  street: "MailingStreet",
  city: "MailingCity",
  country: "MailingCountry",
  postalCode: "MailingPostalCode",
  status: "Collaborator_Status__c",
  stellarAddress: "Stellar_Address__c",
  earnings: "Total_Earnings__c",
  description: "Description",
};

/** Error type that carries an HTTP status + stable code for the error handler. */
export class SalesforceError extends Error {
  constructor(message, { status = 502, code = "salesforce_error", details = null } = {}) {
    super(message);
    this.name = "SalesforceError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function trimTrailingSlash(value) {
  return String(value ?? "").replace(/\/+$/, "");
}

function resolveLoginUrl(loginUrl) {
  return trimTrailingSlash(loginUrl || DEFAULT_SALESFORCE_LOGIN_URL);
}

async function readBody(res) {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function firstErrorMessage(data, fallback) {
  if (Array.isArray(data)) return data[0]?.message ?? fallback;
  if (data && typeof data === "object") {
    return data.message ?? data.error_description ?? data.error ?? fallback;
  }
  return typeof data === "string" && data ? data : fallback;
}

/** Normalize a Salesforce `/services/oauth2/token` response. */
export function normalizeTokenResponse(data = {}) {
  const expiresIn = Number(data.expires_in);
  const hasExpiry = Number.isFinite(expiresIn) && expiresIn > 0;
  const issuedAt = Date.now();
  return {
    accessToken: data.access_token ?? null,
    refreshToken: data.refresh_token ?? null,
    tokenType: data.token_type ?? "Bearer",
    scope: data.scope ?? null,
    instanceUrl: data.instance_url ?? null,
    identityUrl: data.id ?? null,
    issuedAt: new Date(issuedAt).toISOString(),
    expiresIn: hasExpiry ? expiresIn : null,
    expiresAt: hasExpiry ? new Date(issuedAt + expiresIn * 1000).toISOString() : null,
  };
}

/**
 * Build the Salesforce OAuth authorization URL the operator's browser opens
 * to grant access to their org.
 */
export function buildAuthorizeUrl({
  contractId,
  redirectUri,
  state,
  loginUrl,
  clientId,
  scopes,
} = {}) {
  if (!clientId) throw new SalesforceError("SALESFORCE_CLIENT_ID is not configured", { status: 503, code: "salesforce_not_configured" });
  if (!redirectUri) throw new SalesforceError("redirectUri is required", { status: 400, code: "invalid_request" });
  const url = new URL(`${resolveLoginUrl(loginUrl)}/services/oauth2/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", (scopes?.length ? scopes : DEFAULT_SALESFORCE_SCOPES).join(" "));
  if (state) url.searchParams.set("state", state);
  if (contractId) url.searchParams.set("crm_contract_id", contractId);
  return url.toString();
}

/**
 * Create a tamper-proof, expiring OAuth `state` value. Binds the state to the
 * contract id so a leaked state cannot be replayed against another contract.
 */
export function createOAuthState(contractId, secret, { ttlMs = 10 * 60 * 1000, now = Date.now() } = {}) {
  if (!secret) throw new SalesforceError("OAuth state secret is not configured", { status: 503, code: "salesforce_not_configured" });
  const body = Buffer.from(
    JSON.stringify({ c: contractId ?? null, n: crypto.randomBytes(8).toString("hex"), e: now + ttlMs })
  ).toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${signature}`;
}

/** Verify + decode a state produced by {@link createOAuthState}. Returns null when invalid. */
export function verifyOAuthState(state, secret, { now = Date.now() } = {}) {
  if (typeof state !== "string" || !secret) return null;
  const separator = state.indexOf(".");
  if (separator === -1) return null;
  const body = state.slice(0, separator);
  const provided = state.slice(separator + 1);
  const expected = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  if (providedBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(providedBuf, expectedBuf)) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!parsed || typeof parsed.e !== "number" || parsed.e < now) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Exchange an authorization code for access + refresh tokens. */
export async function exchangeCodeForToken({
  code,
  redirectUri,
  clientId,
  clientSecret,
  loginUrl,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!code) throw new SalesforceError("Authorization code is required", { status: 400, code: "invalid_request" });
  if (!clientId || !clientSecret) {
    throw new SalesforceError("Salesforce OAuth credentials are not configured", { status: 503, code: "salesforce_not_configured" });
  }
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri ?? "",
    client_id: clientId,
    client_secret: clientSecret,
  });
  const res = await fetchImpl(`${resolveLoginUrl(loginUrl)}/services/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const data = await readBody(res);
  if (!res.ok || (data && typeof data === "object" && data.error)) {
    throw new SalesforceError(firstErrorMessage(data, "Salesforce OAuth token exchange failed"), {
      status: 401,
      code: "salesforce_oauth_failed",
      details: { error: data?.error ?? null },
    });
  }
  return normalizeTokenResponse(data);
}

/** Refresh an expired access token using a stored refresh token. */
export async function refreshAccessToken({
  refreshToken,
  clientId,
  clientSecret,
  loginUrl,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!refreshToken) {
    throw new SalesforceError("A refresh token is required to renew Salesforce access", { status: 401, code: "salesforce_reconnect_required" });
  }
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });
  const res = await fetchImpl(`${resolveLoginUrl(loginUrl)}/services/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const data = await readBody(res);
  if (!res.ok || (data && typeof data === "object" && data.error)) {
    throw new SalesforceError(firstErrorMessage(data, "Salesforce token refresh failed"), {
      status: 401,
      code: "salesforce_reconnect_required",
      details: { error: data?.error ?? null },
    });
  }
  return normalizeTokenResponse(data);
}

/** True when an ISO timestamp is within `skewMs` of (or past) the current time. */
export function isTokenExpired(expiresAt, { skewMs = 60 * 1000, now = Date.now() } = {}) {
  if (!expiresAt) return false;
  const parsed = Date.parse(expiresAt);
  if (Number.isNaN(parsed)) return false;
  return parsed - skewMs <= now;
}

/**
 * Deterministic AES-256-GCM cipher for OAuth tokens at rest. `decrypt` also
 * tolerates plaintext values so a partially migrated database keeps working.
 */
export function createTokenCipher(secret) {
  if (!secret) {
    throw new SalesforceError("A token encryption secret is required", { status: 503, code: "salesforce_not_configured" });
  }
  const key = crypto.createHash("sha256").update(String(secret)).digest();
  return {
    encrypt(plaintext) {
      if (plaintext === null || plaintext === undefined) return null;
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      const encrypted = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      return `v1:${iv.toString("base64url")}:${tag.toString("base64url")}:${encrypted.toString("base64url")}`;
    },
    decrypt(payload) {
      if (typeof payload !== "string" || !payload.startsWith("v1:")) return payload ?? null;
      const [, ivPart, tagPart, dataPart] = payload.split(":");
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivPart, "base64url"));
      decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
      return Buffer.concat([
        decipher.update(Buffer.from(dataPart, "base64url")),
        decipher.final(),
      ]).toString("utf8");
    },
  };
}

/**
 * Verify the HMAC-SHA256 signature Salesforce (or the Apex middleware in front
 * of it) attaches to an inbound contact webhook.
 */
export function verifyWebhookSignature({ secret, signature, rawBody } = {}) {
  if (!secret || !signature) return false;
  const provided = String(signature).trim().replace(/^sha256=/i, "").toLowerCase();
  if (!/^[0-9a-f]+$/.test(provided)) return false;
  const payload = Buffer.isBuffer(rawBody)
    ? rawBody
    : Buffer.from(typeof rawBody === "string" ? rawBody : JSON.stringify(rawBody ?? {}), "utf8");
  const expected = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  const providedBuf = Buffer.from(provided, "hex");
  const expectedBuf = Buffer.from(expected, "hex");
  return providedBuf.length === expectedBuf.length && crypto.timingSafeEqual(providedBuf, expectedBuf);
}

/** Collapse a 56-char Stellar key into a readable `GABCDEF…WXYZ` label. */
export function shortenAddress(address) {
  if (typeof address !== "string" || address.length < 12) return address ?? null;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** Convert an integer stroop string to a decimal XLM amount (2 dp). */
export function stroopsToAmount(value) {
  if (value === null || value === undefined || value === "") return null;
  let big;
  try {
    big = BigInt(String(value).trim());
  } catch {
    return null;
  }
  const negative = big < 0n;
  const abs = negative ? -big : big;
  const whole = abs / 10_000_000n;
  const fraction = (abs % 10_000_000n).toString().padStart(7, "0").slice(0, 2);
  const amount = Number(`${whole}.${fraction}`);
  return negative ? -amount : amount;
}

/** Split a collaborator's display name into Salesforce First/Last name parts. */
export function splitContactName(collaborator = {}) {
  const firstName = collaborator.firstName?.trim();
  const lastName = collaborator.lastName?.trim();
  if (firstName || lastName) {
    return { FirstName: firstName || undefined, LastName: lastName || firstName };
  }
  const full = (collaborator.name ?? "").trim();
  if (!full) return { LastName: shortenAddress(collaborator.address) ?? "Unknown Collaborator" };
  const parts = full.split(/\s+/);
  if (parts.length === 1) return { LastName: parts[0] };
  return { FirstName: parts.slice(0, -1).join(" "), LastName: parts[parts.length - 1] };
}

function buildContactDescription(collaborator) {
  const bits = [];
  if (collaborator.address) bits.push(`Stellar wallet ${collaborator.address}`);
  if (collaborator.status) bits.push(`status: ${collaborator.status}`);
  if (collaborator.contractId) bits.push(`contract ${collaborator.contractId}`);
  return bits.join(" | ") || "Stellar Royalty Splitter collaborator";
}

/**
 * Pure mapping from a collaborator record to Salesforce Contact fields.
 * Only defined values are emitted so a PATCH never clobbers unrelated fields.
 */
export function buildContactFields(collaborator = {}, fieldMap = DEFAULT_CONTACT_FIELD_MAP) {
  const logical = {};
  const name = splitContactName(collaborator);
  if (name.FirstName) logical.firstName = name.FirstName;
  logical.lastName = name.LastName || "Unknown Collaborator";
  if (collaborator.email) logical.email = collaborator.email;
  if (collaborator.phone) logical.phone = collaborator.phone;
  const street = collaborator.street ?? collaborator.addressLine ?? collaborator.mailingStreet;
  if (street) logical.street = street;
  if (collaborator.city) logical.city = collaborator.city;
  if (collaborator.country) logical.country = collaborator.country;
  if (collaborator.postalCode) logical.postalCode = collaborator.postalCode;
  logical.status = collaborator.status ?? "active";
  if (collaborator.address) logical.stellarAddress = collaborator.address;
  const earnings = collaborator.earningsAmount ?? stroopsToAmount(collaborator.earnings ?? collaborator.totalEarnings);
  if (earnings !== null && earnings !== undefined) logical.earnings = earnings;
  logical.description = buildContactDescription(collaborator);

  const fields = {};
  for (const [logicalKey, salesforceField] of Object.entries(fieldMap ?? {})) {
    if (!salesforceField) continue;
    const value = logical[logicalKey];
    if (value !== undefined) fields[salesforceField] = value;
  }
  return fields;
}

/** Normalize a free-form Salesforce status value onto our status vocabulary. */
export function normalizeCollaboratorStatus(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return null;
  if (["active", "enabled", "ok", "current"].includes(normalized)) return "active";
  if (["suspended", "suspend", "paused", "on hold", "on_hold", "payment hold"].includes(normalized)) {
    return "suspended";
  }
  if (["deactivated", "inactive", "disabled", "terminated", "removed"].includes(normalized)) {
    return "deactivated";
  }
  return null;
}

/** Extract a normalized collaborator status from an inbound Salesforce Contact. */
export function mapContactToCollaboratorStatus(contact = {}) {
  return normalizeCollaboratorStatus(
    contact.Collaborator_Status__c ?? contact.Status__c ?? contact.status ?? contact.Status
  );
}

const SOQL_UNSAFE = /\\|'|%/g;

/** Escape a value for safe interpolation into a SOQL string literal. */
export function escapeSoqlString(value) {
  return String(value).replace(SOQL_UNSAFE, (char) => `\\${char}`);
}

/**
 * Thin Salesforce REST client. All network I/O goes through the injected
 * `fetchImpl` so tests never touch the network.
 */
export class SalesforceClient {
  constructor({
    instanceUrl,
    accessToken,
    apiVersion = process.env.SALESFORCE_API_VERSION || DEFAULT_SALESFORCE_API_VERSION,
    fetchImpl = globalThis.fetch,
  } = {}) {
    if (!instanceUrl) {
      throw new SalesforceError("Salesforce instanceUrl is required", { status: 500, code: "salesforce_not_configured" });
    }
    if (!accessToken) {
      throw new SalesforceError("A Salesforce access token is required", { status: 401, code: "salesforce_reconnect_required" });
    }
    this.instanceUrl = trimTrailingSlash(instanceUrl);
    this.accessToken = accessToken;
    this.apiVersion = apiVersion;
    this.fetchImpl = fetchImpl;
  }

  get baseUrl() {
    return `${this.instanceUrl}/services/data/${this.apiVersion}`;
  }

  /** Low-level request helper shared by every typed method below. */
  async request(path, { method = "GET", query, body, headers } = {}) {
    const url = new URL(`${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
      }
    }
    let res;
    try {
      res = await this.fetchImpl(url.toString(), {
        method,
        headers: {
          authorization: `Bearer ${this.accessToken}`,
          "content-type": "application/json",
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new SalesforceError(`Salesforce request failed: ${err?.message ?? "network error"}`, {
        status: 502,
        code: "salesforce_network_error",
      });
    }
    if (res.status === 204) return null;
    const data = await readBody(res);
    if (!res.ok) {
      const unauthorized = res.status === 401;
      throw new SalesforceError(firstErrorMessage(data, `Salesforce request failed (${res.status})`), {
        status: unauthorized ? 401 : 502,
        code: unauthorized ? "salesforce_reconnect_required" : "salesforce_api_error",
        details: data,
      });
    }
    return data;
  }

  createContact(fields) {
    return this.request("/sobjects/Contact", { method: "POST", body: fields });
  }

  updateContact(contactId, fields) {
    return this.request(`/sobjects/Contact/${encodeURIComponent(contactId)}`, { method: "PATCH", body: fields });
  }

  getContact(contactId) {
    return this.request(`/sobjects/Contact/${encodeURIComponent(contactId)}`);
  }

  /** Upsert by an external-id field (e.g. `Stellar_Address__c`). */
  upsertContactByExternalId(field, value, fields) {
    return this.request(
      `/sobjects/Contact/${encodeURIComponent(field)}/${encodeURIComponent(value)}`,
      { method: "PATCH", body: fields }
    );
  }

  query(soql) {
    return this.request("/query", { query: { q: soql } });
  }

  /** Look a Contact up by the Stellar wallet custom field. */
  findByStellarAddress(address, field = "Stellar_Address__c") {
    return this.query(`SELECT Id, Name FROM Contact WHERE ${field} = '${escapeSoqlString(address)}' LIMIT 1`);
  }

  createActivity(fields) {
    return this.request("/sobjects/Task", { method: "POST", body: fields });
  }
}

/** Convenience factory that decrypts a stored connection's access token. */
export function createSalesforceClient(connection = {}, { fetchImpl, tokenCipher } = {}) {
  const accessToken = tokenCipher ? tokenCipher.decrypt(connection.accessToken) : connection.accessToken;
  return new SalesforceClient({
    instanceUrl: connection.instanceUrl,
    accessToken,
    fetchImpl,
  });
}

/**
 * Build the default Salesforce Task payload for a completed payout.
 * `WhatId` links the activity to the collaborator's Contact.
 */
export function buildPayoutActivity({ contactId, address, amount, currency = "XLM", transactionId, note }) {
  const amountLabel = amount === null || amount === undefined ? null : `${amount} ${currency}`;
  return {
    Subject: `Royalty payout${amountLabel ? ` — ${amountLabel}` : ""}`,
    Status: "Completed",
    Priority: "Normal",
    ActivityDate: new Date().toISOString().slice(0, 10),
    ...(contactId ? { WhoId: contactId } : {}),
    Description: [
      address ? `Stellar wallet: ${address}` : null,
      amountLabel ? `Amount: ${amountLabel}` : null,
      transactionId ? `Transaction: ${transactionId}` : null,
      note || null,
    ]
      .filter(Boolean)
      .join("\n"),
  };
}
