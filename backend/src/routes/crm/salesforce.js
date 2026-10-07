/**
 * Salesforce CRM endpoints (#939).
 *
 * Mounted at `/api/v1/crm/salesforce`:
 *   GET  /connect/url        — build the OAuth authorize URL + signed state
 *   POST /connect            — exchange an authorization code and store tokens
 *   POST /disconnect         — drop the stored OAuth connection
 *   POST /sync-collaborators — push collaborators to Salesforce Contacts
 *   GET  /sync-status        — report connection + last sync progress
 *   POST /payout-activity    — log a royalty payout as a Salesforce activity
 *   POST /webhook            — apply a Salesforce Contact update to a collaborator
 *
 * Mutating endpoints require the `operator` role; the inbound webhook is
 * authenticated with an HMAC-SHA256 signature instead of RBAC.
 */
import crypto from "crypto";
import { Router } from "express";
import { z } from "zod";
import { sendError } from "../../error-response.js";
import logger from "../../logger.js";
import { requireRole } from "../../middleware/rbac.js";
import { validate, contractAddress, stellarAddress } from "../../validation.js";
import { addAuditLog } from "../../database/index.js";
import {
  CRM_PROVIDER,
  getConnection,
  saveConnection,
  disconnectConnection,
  updateConnectionTokens,
  getSyncStatus,
  startSync,
  incrementSyncProgress,
  finishSync,
  upsertContactMapping,
  getContactMappingByAddress,
  findContactMappingByExternalId,
  listContactMappings,
  recordCrmActivity,
  listCrmActivities,
  listKnownCollaborators,
} from "../../database/crm-sync-status.js";
import { setContributorStatus } from "../../database/contributor-status.js";
import {
  DEFAULT_SALESFORCE_LOGIN_URL,
  DEFAULT_CONTACT_FIELD_MAP,
  SalesforceError,
  buildAuthorizeUrl,
  createOAuthState,
  verifyOAuthState,
  exchangeCodeForToken,
  refreshAccessToken,
  isTokenExpired,
  createTokenCipher,
  createSalesforceClient,
  buildContactFields,
  buildPayoutActivity,
  mapContactToCollaboratorStatus,
  verifyWebhookSignature,
} from "../../services/salesforce.js";

export const salesforceRouter = Router();

// ── Configuration ───────────────────────────────────────────────────────────

/** Merge a JSON `SALESFORCE_CONTACT_FIELDS` override into the default map. */
export function parseFieldMap(raw) {
  if (!raw) return { ...DEFAULT_CONTACT_FIELD_MAP };
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ...DEFAULT_CONTACT_FIELD_MAP };
    return { ...DEFAULT_CONTACT_FIELD_MAP, ...parsed };
  } catch {
    logger.warn("Invalid SALESFORCE_CONTACT_FIELDS JSON — using defaults");
    return { ...DEFAULT_CONTACT_FIELD_MAP };
  }
}

function getConfig() {
  return {
    clientId: process.env.SALESFORCE_CLIENT_ID || null,
    clientSecret: process.env.SALESFORCE_CLIENT_SECRET || null,
    loginUrl: process.env.SALESFORCE_LOGIN_URL || DEFAULT_SALESFORCE_LOGIN_URL,
    webhookSecret: process.env.SALESFORCE_WEBHOOK_SECRET || null,
    tokenSecret: process.env.SALESFORCE_TOKEN_ENCRYPTION_KEY || process.env.SALESFORCE_CLIENT_SECRET || null,
    fieldMap: parseFieldMap(process.env.SALESFORCE_CONTACT_FIELDS),
  };
}

function ensureOAuthConfigured(config, res) {
  if (!config.clientId || !config.clientSecret) {
    sendError(
      res,
      503,
      "salesforce_not_configured",
      "SALESFORCE_CLIENT_ID and SALESFORCE_CLIENT_SECRET must be configured"
    );
    return false;
  }
  return true;
}

function constantTimeEquals(a, b) {
  if (!a || !b) return false;
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

/** Never leak OAuth tokens through the API. */
function sanitizeConnection(connection) {
  if (!connection) return null;
  return {
    contractId: connection.contractId,
    provider: connection.provider,
    instanceUrl: connection.instanceUrl,
    orgId: connection.orgId,
    status: connection.status,
    connectedBy: connection.connectedBy,
    accessTokenExpiresAt: connection.accessTokenExpiresAt,
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
  };
}

/**
 * Resolve a connected Salesforce client for a contract, transparently
 * refreshing an expired access token and persisting the rotated tokens.
 */
async function buildClientForContract(contractId, config) {
  const connection = getConnection(contractId);
  if (!connection || connection.status !== "connected") {
    return { connection: null, client: null };
  }
  const cipher = createTokenCipher(config.tokenSecret);
  let active = connection;

  if (isTokenExpired(connection.accessTokenExpiresAt) && connection.refreshToken) {
    const refreshed = await refreshAccessToken({
      refreshToken: cipher.decrypt(connection.refreshToken),
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      loginUrl: config.loginUrl,
    });
    const accessToken = cipher.encrypt(refreshed.accessToken);
    const refreshToken = refreshed.refreshToken ? cipher.encrypt(refreshed.refreshToken) : null;
    active =
      updateConnectionTokens(contractId, {
        accessToken,
        refreshToken,
        accessTokenExpiresAt: refreshed.expiresAt,
      }) ?? { ...connection, accessToken, refreshToken, accessTokenExpiresAt: refreshed.expiresAt };
  }

  return { connection: active, client: createSalesforceClient(active, { tokenCipher: cipher }) };
}

// ── Schemas ─────────────────────────────────────────────────────────────────

const connectSchema = z.object({
  contractId: contractAddress,
  code: z.string().min(1, "code is required"),
  redirectUri: z.string().url("redirectUri must be a valid URL"),
  state: z.string().min(1, "state is required"),
  connectedBy: z.string().max(120).optional().nullable(),
});

const syncCollaboratorSchema = z.object({
  address: stellarAddress,
  name: z.string().max(200).optional().nullable(),
  email: z.string().email().max(254).optional().nullable(),
  phone: z.string().max(50).optional().nullable(),
  street: z.string().max(255).optional().nullable(),
  city: z.string().max(120).optional().nullable(),
  country: z.string().max(120).optional().nullable(),
  postalCode: z.string().max(40).optional().nullable(),
  status: z.enum(["active", "suspended", "deactivated"]).optional(),
  earnings: z
    .string()
    .regex(/^\d+$/, "earnings must be an integer string of stroops")
    .optional()
    .nullable(),
});

const syncSchema = z.object({
  contractId: contractAddress,
  collaborators: z.array(syncCollaboratorSchema).max(500).optional(),
});

const payoutActivitySchema = z.object({
  contractId: contractAddress,
  address: stellarAddress,
  amount: z.union([z.string().max(50), z.number()]).optional().nullable(),
  currency: z.string().max(12).optional(),
  transactionId: z.string().max(120).optional().nullable(),
  note: z.string().max(500).optional().nullable(),
});

const webhookSchema = z
  .object({
    ContactId: z.string().min(1),
    Status: z.string().max(60).optional().nullable(),
    Reason: z.string().max(500).optional().nullable(),
  })
  .passthrough();

function parseContractIdQuery(req, res) {
  const parsed = contractAddress.safeParse(req.query.contractId);
  if (!parsed.success) {
    sendError(res, 400, "invalid_contract_id", "Invalid contract ID format");
    return null;
  }
  return parsed.data;
}

function parseActivityPayload(row) {
  let payload = null;
  if (row.payload) {
    try {
      payload = JSON.parse(row.payload);
    } catch {
      payload = row.payload;
    }
  }
  return { ...row, payload };
}

// ── OAuth ───────────────────────────────────────────────────────────────────

/**
 * GET /api/v1/crm/salesforce/connect/url
 * Returns the Salesforce authorize URL + signed state for the operator to open.
 */
salesforceRouter.get("/connect/url", requireRole("operator"), (req, res, next) => {
  try {
    const contractId = parseContractIdQuery(req, res);
    if (!contractId) return;
    const { redirectUri } = req.query;
    if (typeof redirectUri !== "string" || !redirectUri) {
      return sendError(res, 400, "invalid_redirect_uri", "redirectUri query parameter is required");
    }
    const config = getConfig();
    if (!ensureOAuthConfigured(config, res)) return;

    const state = createOAuthState(contractId, config.clientSecret);
    const authorizeUrl = buildAuthorizeUrl({
      contractId,
      redirectUri,
      state,
      loginUrl: config.loginUrl,
      clientId: config.clientId,
    });
    res.json({ success: true, data: { authorizeUrl, state, loginUrl: config.loginUrl } });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/crm/salesforce/connect
 * Exchanges the OAuth authorization code for tokens and stores the connection.
 */
salesforceRouter.post("/connect", requireRole("operator"), validate(connectSchema), async (req, res, next) => {
  try {
    const config = getConfig();
    if (!ensureOAuthConfigured(config, res)) return;

    const { contractId, code, redirectUri, state, connectedBy } = req.body;
    const verified = verifyOAuthState(state, config.clientSecret);
    if (!verified || (verified.c && verified.c !== contractId)) {
      return sendError(
        res,
        400,
        "invalid_oauth_state",
        "OAuth state is missing, expired, or does not match the contract"
      );
    }

    const tokens = await exchangeCodeForToken({
      code,
      redirectUri,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      loginUrl: config.loginUrl,
    });
    if (!tokens.instanceUrl) {
      throw new SalesforceError("Salesforce token response did not include an instance_url", {
        status: 502,
        code: "salesforce_api_error",
      });
    }

    const cipher = createTokenCipher(config.tokenSecret);
    const connection = saveConnection({
      contractId,
      instanceUrl: tokens.instanceUrl,
      orgId: tokens.identityUrl,
      accessToken: cipher.encrypt(tokens.accessToken),
      refreshToken: cipher.encrypt(tokens.refreshToken),
      accessTokenExpiresAt: tokens.expiresAt,
      connectedBy: connectedBy ?? null,
    });

    addAuditLog(contractId, "salesforce_connected", connectedBy ?? null, {
      instanceUrl: tokens.instanceUrl,
      provider: CRM_PROVIDER,
    });
    recordCrmActivity({
      contractId,
      activityType: "connection_created",
      payload: { instanceUrl: tokens.instanceUrl },
    });
    logger.info("Salesforce org connected", { contractId, instanceUrl: tokens.instanceUrl });

    res.status(201).json({ success: true, data: sanitizeConnection(connection) });
  } catch (err) {
    next(err);
  }
});

/** POST /api/v1/crm/salesforce/disconnect */
salesforceRouter.post("/disconnect", requireRole("operator"), (req, res, next) => {
  try {
    const contractId = parseContractIdQuery(req, res);
    if (!contractId) return;
    const removed = disconnectConnection(contractId);
    if (!removed) return sendError(res, 404, "not_found", "No Salesforce connection for this contract");

    addAuditLog(contractId, "salesforce_disconnected", null, { provider: CRM_PROVIDER });
    recordCrmActivity({ contractId, activityType: "connection_removed" });
    res.json({ success: true, data: { contractId, status: "disconnected" } });
  } catch (err) {
    next(err);
  }
});

// ── Sync ────────────────────────────────────────────────────────────────────

/**
 * POST /api/v1/crm/salesforce/sync-collaborators
 * Creates/updates a Salesforce Contact for every collaborator. When the body
 * omits `collaborators`, the list is derived from the local database.
 */
salesforceRouter.post(
  "/sync-collaborators",
  requireRole("operator"),
  validate(syncSchema),
  async (req, res, next) => {
    const startedAt = Date.now();
    const { contractId, collaborators } = req.body;
    try {
      const config = getConfig();
      if (!ensureOAuthConfigured(config, res)) return;

      const { connection, client } = await buildClientForContract(contractId, config);
      if (!connection) {
        return sendError(res, 400, "salesforce_not_connected", "No active Salesforce connection for this contract");
      }

      const queued = collaborators?.length
        ? collaborators
        : listKnownCollaborators(contractId).map((collaborator) => ({ ...collaborator }));

      startSync(contractId, queued.length);

      const results = { total: queued.length, created: 0, updated: 0, failed: 0, errors: [] };
      for (const collaborator of queued) {
        try {
          const fields = buildContactFields(collaborator, config.fieldMap);
          const existing = getContactMappingByAddress(contractId, collaborator.address);
          let externalId = existing?.externalId ?? null;
          let action = "updated";

          if (externalId) {
            await client.updateContact(externalId, fields);
          } else {
            const created = await client.createContact(fields);
            externalId = created?.id ?? null;
            action = "created";
            if (!externalId) {
              throw new SalesforceError("Salesforce did not return a Contact id", {
                status: 502,
                code: "salesforce_api_error",
              });
            }
          }

          upsertContactMapping({
            contractId,
            address: collaborator.address,
            externalId,
            name: collaborator.name ?? null,
            email: collaborator.email ?? null,
            direction: "outbound",
          });
          recordCrmActivity({
            contractId,
            address: collaborator.address,
            activityType: action === "created" ? "contact_created" : "contact_updated",
            externalId,
            payload: { status: collaborator.status ?? "active" },
          });
          results[action] += 1;
          incrementSyncProgress(contractId, { synced: 1 });
        } catch (err) {
          results.failed += 1;
          results.errors.push({
            address: collaborator.address,
            message: err?.message ?? String(err),
          });
          recordCrmActivity({
            contractId,
            address: collaborator.address,
            activityType: "contact_sync_failed",
            status: "failed",
            error: err?.message ?? String(err),
          });
          incrementSyncProgress(contractId, { failed: 1 });
        }
      }

      const status = results.failed > 0 && results.created + results.updated === 0 ? "failed" : "completed";
      const sync = finishSync(contractId, {
        status,
        error: results.failed > 0 ? `${results.failed} collaborator(s) failed` : null,
      });

      addAuditLog(contractId, "salesforce_sync_completed", null, { ...results });
      logger.info("Salesforce collaborator sync finished", {
        contractId,
        ...results,
        durationMs: Date.now() - startedAt,
      });

      res.json({ success: true, data: { ...results, sync } });
    } catch (err) {
      // Reflect the failure in sync status when the run had already started.
      try {
        finishSync(contractId, { status: "failed", error: err?.message ?? String(err) });
      } catch {
        // never mask the original error
      }
      next(err);
    }
  }
);

/**
 * GET /api/v1/crm/salesforce/sync-status
 * Reports connection state, last sync progress, and recent CRM activity.
 */
salesforceRouter.get("/sync-status", requireRole("operator"), (req, res, next) => {
  try {
    const contractId = parseContractIdQuery(req, res);
    if (!contractId) return;

    const connection = getConnection(contractId);
    const sync =
      getSyncStatus(contractId) ?? {
        contractId,
        provider: CRM_PROVIDER,
        status: "idle",
        totalCollaborators: 0,
        syncedCount: 0,
        failedCount: 0,
        lastSyncedAt: null,
        lastError: null,
      };
    const mappings = listContactMappings(contractId);
    const recentActivity = listCrmActivities(contractId, { limit: 10 }).map(parseActivityPayload);

    res.json({
      success: true,
      data: {
        contractId,
        provider: CRM_PROVIDER,
        connected: connection?.status === "connected",
        connection: sanitizeConnection(connection),
        sync,
        contacts: {
          mapped: mappings.length,
          lastDirection: mappings[0]?.lastDirection ?? null,
        },
        recentActivity,
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/crm/salesforce/payout-activity
 * Records a completed payout as a Salesforce activity on the linked Contact.
 */
salesforceRouter.post(
  "/payout-activity",
  requireRole("operator"),
  validate(payoutActivitySchema),
  async (req, res, next) => {
    try {
      const config = getConfig();
      if (!ensureOAuthConfigured(config, res)) return;

      const { contractId, address, amount, currency, transactionId, note } = req.body;
      const mapping = getContactMappingByAddress(contractId, address);
      if (!mapping?.externalId) {
        return sendError(res, 404, "contact_not_mapped", "Collaborator is not yet synced to Salesforce");
      }

      const { connection, client } = await buildClientForContract(contractId, config);
      if (!connection) {
        return sendError(res, 400, "salesforce_not_connected", "No active Salesforce connection for this contract");
      }

      const activity = buildPayoutActivity({
        contactId: mapping.externalId,
        address,
        amount,
        currency,
        transactionId,
        note,
      });
      const created = await client.createActivity(activity);

      recordCrmActivity({
        contractId,
        address,
        activityType: "payout_activity_created",
        externalId: created?.id ?? null,
        payload: { amount: amount ?? null, currency: currency ?? "XLM", transactionId: transactionId ?? null },
      });

      res.status(201).json({
        success: true,
        data: { activityId: created?.id ?? null, contactId: mapping.externalId },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ── Inbound webhook ─────────────────────────────────────────────────────────

/**
 * POST /api/v1/crm/salesforce/webhook
 * Applies a Contact update from Salesforce back onto the collaborator record.
 * Authenticated by HMAC signature (`X-Salesforce-Signature`) or a shared
 * secret header (`X-Webhook-Token`).
 */
salesforceRouter.post("/webhook", (req, res, next) => {
  try {
    const config = getConfig();
    if (!config.webhookSecret) {
      return sendError(
        res,
        503,
        "salesforce_webhook_not_configured",
        "SALESFORCE_WEBHOOK_SECRET is not configured"
      );
    }

    const signature = req.get("x-salesforce-signature") || req.get("x-webhook-signature");
    const token = req.get("x-webhook-token");
    const signatureValid = verifyWebhookSignature({
      secret: config.webhookSecret,
      signature,
      rawBody: req.rawBody ?? req.body,
    });
    const tokenValid = constantTimeEquals(token, config.webhookSecret);
    if (!signatureValid && !tokenValid) {
      return sendError(res, 401, "invalid_signature", "Webhook signature verification failed");
    }

    const parsed = webhookSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, 400, "invalid_webhook_payload", "ContactId is required");
    }

    const { ContactId, Status, Reason } = parsed.data;
    const mapping = findContactMappingByExternalId(ContactId);
    if (!mapping) {
      return sendError(res, 404, "contact_not_mapped", "Inbound Contact is not linked to a collaborator");
    }

    const status = mapContactToCollaboratorStatus({ Collaborator_Status__c: Status, status: Status });
    if (!status) {
      return sendError(res, 400, "invalid_collaborator_status", "Unrecognized collaborator status value");
    }

    const record = setContributorStatus(mapping.contractId, mapping.address, status, {
      reason: Reason ?? "Salesforce contact updated",
      updatedBy: null,
    });
    upsertContactMapping({
      contractId: mapping.contractId,
      address: mapping.address,
      externalId: ContactId,
      direction: "inbound",
    });
    recordCrmActivity({
      contractId: mapping.contractId,
      address: mapping.address,
      activityType: "contact_status_updated",
      externalId: ContactId,
      payload: { status, reason: Reason ?? null },
    });
    addAuditLog(mapping.contractId, `crm_contact_${status}`, null, {
      address: mapping.address,
      source: "salesforce",
      reason: Reason ?? null,
    });
    logger.info("Salesforce contact update applied", {
      contractId: mapping.contractId,
      address: mapping.address,
      status,
    });

    res.json({
      success: true,
      data: { contractId: mapping.contractId, address: mapping.address, status, record },
    });
  } catch (err) {
    next(err);
  }
});

export default salesforceRouter;
