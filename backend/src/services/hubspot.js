/**
 * HubSpot CRM integration service (#946).
 *
 * Framework-free wrapper around the HubSpot REST API for OAuth, contact sync,
 * and deal creation. Similar pattern to Salesforce (#939) but tailored to
 * HubSpot's contact and deal architecture.
 *
 * OAuth tokens are encrypted at rest (AES-256-GCM) before handed to persistence.
 * The key is derived from `HUBSPOT_CLIENT_SECRET` (or explicit `HUBSPOT_TOKEN_ENCRYPTION_KEY`).
 *
 * Required environment:
 *   HUBSPOT_CLIENT_ID       — OAuth app client key
 *   HUBSPOT_CLIENT_SECRET   — OAuth app client secret
 * Optional:
 *   HUBSPOT_TOKEN_ENCRYPTION_KEY  — explicit token cipher key
 *   HUBSPOT_WEBHOOK_SECRET  — for inbound contact webhooks
 *   HUBSPOT_DEAL_THRESHOLD  — payout amount to create deal (default $10,000)
 */
import crypto from "crypto";

export const HUBSPOT_PROVIDER = "hubspot";
export const DEFAULT_HUBSPOT_API_URL = "https://api.hubapi.com";
export const DEFAULT_HUBSPOT_SCOPES = [
  "crm.objects.contacts.read",
  "crm.objects.contacts.write",
  "crm.objects.deals.read",
  "crm.objects.deals.write",
  "oauth",
];
export const DEFAULT_HUBSPOT_DEAL_THRESHOLD = 10000; // $10,000

/** HubSpot contact and deal field mappings */
export const DEFAULT_HUBSPOT_CONTACT_FIELDS = {
  firstName: "firstname",
  lastName: "lastname",
  email: "email",
  phone: "phone",
  street: "hs_lead_address",
  city: "hs_lead_city",
  state: "hs_lead_state",
  country: "country",
  postalCode: "zip",
  stellarAddress: "stellar_address",
  earnings: "total_royalty_earnings",
};

/** HubSpot deal stage values */
export const HUBSPOT_DEAL_STAGES = {
  NEGOTIATION: "negotiation",
  DECISION_MAKER_BROUGHT_IN: "decision_maker_brought_in",
  PRESENTATION_SCHEDULED: "presentation_scheduled",
  PROPOSAL_PRESENTED: "proposal_presented",
  NEGOTIATION_REVIEW: "negotiation_review",
  CLOSED_WON: "closedwon",
  CLOSED_LOST: "closedlost",
};

export class HubSpotError extends Error {
  constructor(message, { status = 502, code = "hubspot_error", details = null } = {}) {
    super(message);
    this.name = "HubSpotError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function trimTrailingSlash(value) {
  return String(value ?? "").replace(/\/+$/, "");
}

function resolveApiUrl(apiUrl) {
  return trimTrailingSlash(apiUrl || DEFAULT_HUBSPOT_API_URL);
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

/** Normalize HubSpot OAuth token response */
export function normalizeTokenResponse(data = {}) {
  const expiresIn = Number(data.expires_in);
  const hasExpiry = Number.isFinite(expiresIn) && expiresIn > 0;
  const issuedAt = Date.now();
  return {
    accessToken: data.access_token ?? null,
    refreshToken: data.refresh_token ?? null,
    tokenType: data.token_type ?? "Bearer",
    scope: data.scope ?? null,
    expiresIn: hasExpiry ? expiresIn : null,
    expiresAt: hasExpiry ? new Date(issuedAt + expiresIn * 1000).toISOString() : null,
    issuedAt: new Date(issuedAt).toISOString(),
  };
}

/** Build HubSpot OAuth authorization URL */
export function buildAuthorizeUrl({
  contractId,
  redirectUri,
  state,
  clientId,
  scopes,
} = {}) {
  if (!clientId) throw new HubSpotError("HUBSPOT_CLIENT_ID is not configured", { status: 503, code: "hubspot_not_configured" });
  if (!redirectUri) throw new HubSpotError("redirectUri is required", { status: 400, code: "invalid_request" });
  
  const url = new URL("https://app.hubspot.com/oauth/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", (scopes?.length ? scopes : DEFAULT_HUBSPOT_SCOPES).join(" "));
  if (state) url.searchParams.set("state", state);
  if (contractId) url.searchParams.set("crm_contract_id", contractId);
  return url.toString();
}

/** Create a tamper-proof, expiring OAuth state value */
export function createOAuthState(contractId, secret, { ttlMs = 10 * 60 * 1000, now = Date.now() } = {}) {
  if (!secret) throw new HubSpotError("OAuth state secret is not configured", { status: 503, code: "hubspot_not_configured" });
  const body = Buffer.from(
    JSON.stringify({ c: contractId ?? null, n: crypto.randomBytes(8).toString("hex"), e: now + ttlMs })
  ).toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${signature}`;
}

/** Verify and decode OAuth state */
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

/** Exchange authorization code for access token */
export async function exchangeCodeForToken({
  code,
  redirectUri,
  clientId,
  clientSecret,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!code) throw new HubSpotError("Authorization code is required", { status: 400, code: "invalid_request" });
  if (!clientId || !clientSecret) {
    throw new HubSpotError("HubSpot OAuth credentials are not configured", { status: 503, code: "hubspot_not_configured" });
  }
  
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri ?? "",
    code,
  });
  
  const res = await fetchImpl("https://api.hubapi.com/oauth/v1/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  
  const data = await readBody(res);
  if (!res.ok || (data && typeof data === "object" && data.error)) {
    throw new HubSpotError(firstErrorMessage(data, "HubSpot OAuth token exchange failed"), {
      status: 401,
      code: "hubspot_oauth_failed",
      details: { error: data?.error ?? null },
    });
  }
  return normalizeTokenResponse(data);
}

/** Refresh an access token using refresh token */
export async function refreshAccessToken({
  refreshToken,
  clientId,
  clientSecret,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!refreshToken || !clientId || !clientSecret) {
    throw new HubSpotError("Refresh token and OAuth credentials are required", { status: 503, code: "hubspot_not_configured" });
  }
  
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
  });
  
  const res = await fetchImpl("https://api.hubapi.com/oauth/v1/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  
  const data = await readBody(res);
  if (!res.ok) {
    throw new HubSpotError(firstErrorMessage(data, "HubSpot token refresh failed"), {
      status: 401,
      code: "hubspot_token_refresh_failed",
    });
  }
  return normalizeTokenResponse(data);
}

/** Check if token is expired or close to expiry (5 min buffer) */
export function isTokenExpired(token, bufferMs = 5 * 60 * 1000) {
  if (!token || !token.expiresAt) return false;
  const expiresAtMs = new Date(token.expiresAt).getTime();
  return Date.now() + bufferMs >= expiresAtMs;
}

/** Create AES cipher for token encryption */
export function createTokenCipher(secret) {
  if (!secret) throw new HubSpotError("Token encryption secret is required");
  // Derive a consistent 32-byte key from the secret
  const key = crypto.createHash("sha256").update(secret).digest();
  return { key };
}

/** Encrypt token object with cipher */
export function encryptToken(token, cipherKey) {
  if (!cipherKey) throw new HubSpotError("Cipher key is required");
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-gcm", cipherKey, iv);
  const plaintext = JSON.stringify(token);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return JSON.stringify({
    iv: iv.toString("hex"),
    encrypted: encrypted.toString("hex"),
    authTag: authTag.toString("hex"),
  });
}

/** Decrypt token object with cipher */
export function decryptToken(encryptedJson, cipherKey) {
  if (!cipherKey) throw new HubSpotError("Cipher key is required");
  try {
    const { iv, encrypted, authTag } = JSON.parse(encryptedJson);
    const decipher = crypto.createDecipheriv("aes-256-gcm", cipherKey, Buffer.from(iv, "hex"));
    decipher.setAuthTag(Buffer.from(authTag, "hex"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(encrypted, "hex")),
      decipher.final(),
    ]).toString("utf8");
    return JSON.parse(plaintext);
  } catch (err) {
    throw new HubSpotError("Token decryption failed", { status: 500, code: "token_decrypt_failed" });
  }
}

/** Create HubSpot API client with authorization */
export function createHubSpotClient(accessToken, apiUrl = DEFAULT_HUBSPOT_API_URL, fetchImpl = globalThis.fetch) {
  const baseUrl = resolveApiUrl(apiUrl);
  
  async function request(method, endpoint, body = null) {
    const url = `${baseUrl}${endpoint}`;
    const options = {
      method,
      headers: {
        "authorization": `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
    };
    
    if (body && (method === "POST" || method === "PUT" || method === "PATCH")) {
      options.body = JSON.stringify(body);
    }
    
    const res = await fetchImpl(url, options);
    const data = await readBody(res);
    
    if (!res.ok) {
      throw new HubSpotError(firstErrorMessage(data, `HubSpot API error: ${res.status}`), {
        status: res.status >= 500 ? 502 : 400,
        code: data?.code ?? "hubspot_api_error",
        details: data,
      });
    }
    
    return data;
  }
  
  return {
    // Create or update a contact
    upsertContact: async (email, properties) => {
      return request("POST", "/crm/v3/objects/contacts/batch/upsert", {
        inputs: [
          {
            idProperty: "email",
            id: email,
            properties,
          },
        ],
      });
    },
    
    // Get contact by email
    getContact: async (email) => {
      return request("GET", `/crm/v3/objects/contacts/${email}?idProperty=email&properties=${Object.values(DEFAULT_HUBSPOT_CONTACT_FIELDS).join(",")}`, null);
    },
    
    // Create a deal
    createDeal: async (properties) => {
      return request("POST", "/crm/v3/objects/deals", { properties });
    },
    
    // Update a deal
    updateDeal: async (dealId, properties) => {
      return request("PATCH", `/crm/v3/objects/deals/${dealId}`, { properties });
    },
    
    // Get deal by ID
    getDeal: async (dealId) => {
      return request("GET", `/crm/v3/objects/deals/${dealId}?properties=${Object.values({ dealstage: "dealstage", dealname: "dealname", amount: "amount" }).join(",")}`, null);
    },
    
    // Batch read contacts
    readContacts: async (emails) => {
      return request("POST", "/crm/v3/objects/contacts/batch/read", {
        inputs: emails.map(email => ({ id: email, idProperty: "email" })),
        properties: Object.values(DEFAULT_HUBSPOT_CONTACT_FIELDS),
      });
    },
    
    // Associate contact to deal
    associateContactToDeal: async (contactId, dealId) => {
      return request("POST", `/crm/v3/objects/deals/${dealId}/associations/contacts/${contactId}`, {
        associationCategory: "HUBSPOT_DEFINED",
        associationType: "deal_to_contact",
      });
    },
  };
}

/** Verify HubSpot webhook signature */
export function verifyWebhookSignature(requestBody, signature, secret) {
  if (!signature || !secret) return false;
  const hash = crypto
    .createHmac("sha256", secret)
    .update(requestBody)
    .digest("hex");
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(hash));
}

/** Map HubSpot contact properties to collaborator status */
export function mapContactToCollaboratorStatus(contact) {
  const props = contact?.properties ?? {};
  return {
    email: props.email?.value,
    firstName: props.firstname?.value,
    lastName: props.lastname?.value,
    phone: props.phone?.value,
    stellarAddress: props.stellar_address?.value,
    earnings: parseFloat(props.total_royalty_earnings?.value ?? 0),
  };
}

/** Build HubSpot contact properties from collaborator data */
export function buildContactProperties(collaborator = {}, fieldMap = DEFAULT_HUBSPOT_CONTACT_FIELDS) {
  const properties = {};
  
  if (collaborator.firstName) properties[fieldMap.firstName] = collaborator.firstName;
  if (collaborator.lastName) properties[fieldMap.lastName] = collaborator.lastName;
  if (collaborator.email) properties[fieldMap.email] = collaborator.email;
  if (collaborator.phone) properties[fieldMap.phone] = collaborator.phone;
  if (collaborator.street) properties[fieldMap.street] = collaborator.street;
  if (collaborator.city) properties[fieldMap.city] = collaborator.city;
  if (collaborator.country) properties[fieldMap.country] = collaborator.country;
  if (collaborator.postalCode) properties[fieldMap.postalCode] = collaborator.postalCode;
  if (collaborator.stellarAddress) properties[fieldMap.stellarAddress] = collaborator.stellarAddress;
  if (collaborator.earnings) properties[fieldMap.earnings] = String(collaborator.earnings);
  
  return properties;
}

/** Build HubSpot deal properties from payout data */
export function buildDealProperties(payout = {}, fieldMap = { dealname: "dealname", amount: "amount", dealstage: "dealstage" }) {
  const properties = {};
  
  if (payout.dealName) properties[fieldMap.dealname] = payout.dealName;
  if (payout.amount) properties[fieldMap.amount] = String(payout.amount);
  if (payout.stage) properties[fieldMap.dealstage] = payout.stage;
  
  return properties;
}
