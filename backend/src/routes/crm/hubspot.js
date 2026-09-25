/**
 * HubSpot CRM endpoints (#946).
 *
 * Mounted at `/api/v1/crm/hubspot`:
 *   GET  /connect/url        — build the OAuth authorize URL + signed state
 *   POST /connect            — exchange an authorization code and store tokens
 *   POST /disconnect         — drop the stored OAuth connection
 *   POST /sync-collaborators — push collaborators to HubSpot Contacts
 *   POST /sync-deals         — create HubSpot Deals for large payouts
 *   GET  /sync-status        — report connection + last sync progress
 *   POST /webhook            — apply HubSpot Contact update to a collaborator
 *
 * Mutating endpoints require the `operator` role; the inbound webhook is
 * authenticated with an HMAC-SHA256 signature.
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
  listKnownCollaborators,
} from "../../database/crm-sync-status.js";
import { setContributorStatus } from "../../database/contributor-status.js";
import {
  HUBSPOT_PROVIDER,
  DEFAULT_HUBSPOT_CONTACT_FIELDS,
  DEFAULT_HUBSPOT_DEAL_THRESHOLD,
  HUBSPOT_DEAL_STAGES,
  HubSpotError,
  buildAuthorizeUrl,
  createOAuthState,
  verifyOAuthState,
  exchangeCodeForToken,
  refreshAccessToken,
  isTokenExpired,
  createTokenCipher,
  decryptToken,
  encryptToken,
  createHubSpotClient,
  buildContactProperties,
  buildDealProperties,
  mapContactToCollaboratorStatus,
  verifyWebhookSignature,
} from "../../services/hubspot.js";

export const hubspotRouter = Router();

// ── Configuration ───────────────────────────────────────────────────────────

function parseFieldMap(raw) {
  if (!raw) return { ...DEFAULT_HUBSPOT_CONTACT_FIELDS };
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ...DEFAULT_HUBSPOT_CONTACT_FIELDS };
    }
    return { ...DEFAULT_HUBSPOT_CONTACT_FIELDS, ...parsed };
  } catch {
    logger.warn("Invalid HUBSPOT_CONTACT_FIELDS JSON — using defaults");
    return { ...DEFAULT_HUBSPOT_CONTACT_FIELDS };
  }
}

function getConfig() {
  return {
    clientId: process.env.HUBSPOT_CLIENT_ID || null,
    clientSecret: process.env.HUBSPOT_CLIENT_SECRET || null,
    webhookSecret: process.env.HUBSPOT_WEBHOOK_SECRET || null,
    tokenSecret: process.env.HUBSPOT_TOKEN_ENCRYPTION_KEY || process.env.HUBSPOT_CLIENT_SECRET || null,
    dealThreshold: parseInt(process.env.HUBSPOT_DEAL_THRESHOLD ?? String(DEFAULT_HUBSPOT_DEAL_THRESHOLD), 10),
    fieldMap: parseFieldMap(process.env.HUBSPOT_CONTACT_FIELDS),
  };
}

function ensureOAuthConfigured(config, res) {
  if (!config.clientId || !config.clientSecret) {
    sendError(
      res,
      503,
      "hubspot_not_configured",
      "HUBSPOT_CLIENT_ID and HUBSPOT_CLIENT_SECRET must be configured"
    );
    return false;
  }
  return true;
}

function constantTimeEquals(a, b) {
  const bufA = Buffer.from(a ?? "");
  const bufB = Buffer.from(b ?? "");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function sanitizeConnection(connection) {
  if (!connection) return null;
  const copy = { ...connection };
  delete copy.accessToken;
  delete copy.refreshToken;
  return copy;
}

/** Helper to get and refresh client access token */
async function getAccessTokenForContract(contractId, config) {
  const connection = getConnection(contractId, HUBSPOT_PROVIDER);
  if (!connection) {
    return { connection: null, accessToken: null };
  }

  try {
    const cipher = createTokenCipher(config.tokenSecret);
    const decrypted = decryptToken(connection.accessToken, cipher.key);
    
    if (isTokenExpired(decrypted)) {
      const decryptedRefresh = decryptToken(connection.refreshToken, cipher.key);
      const newToken = await refreshAccessToken({
        refreshToken: decryptedRefresh.refreshToken,
        clientId: config.clientId,
        clientSecret: config.clientSecret,
      });
      
      const newCipher = createTokenCipher(config.tokenSecret);
      updateConnectionTokens(connection.id, {
        accessToken: encryptToken(newToken, newCipher.key),
        refreshToken: encryptToken({ refreshToken: newToken.refreshToken }, newCipher.key),
      });
      return { connection, accessToken: newToken.accessToken };
    }
    
    return { connection, accessToken: decrypted.accessToken };
  } catch (err) {
    logger.error("Token management error", { contractId, error: err.message });
    throw new HubSpotError("Failed to manage access token", { status: 502, code: "token_error" });
  }
}

// ── OAuth: Get Authorization URL ─────────────────────────────────────────────

hubspotRouter.get("/connect/url", requireRole("operator"), async (req, res) => {
  try {
    const config = getConfig();
    if (!ensureOAuthConfigured(config, res)) return;

    const { contractId, redirectUri } = validate(
      req.query,
      z.object({
        contractId: contractAddress,
        redirectUri: z.string().url(),
      })
    );

    const state = createOAuthState(contractId, config.clientSecret);
    const authorizeUrl = buildAuthorizeUrl({
      contractId,
      redirectUri,
      state,
      clientId: config.clientId,
    });

    res.json({ authorizeUrl, state });
  } catch (err) {
    if (err instanceof HubSpotError) {
      sendError(res, err.status, err.code, err.message);
    } else {
      logger.error("Error building OAuth URL", { error: err.message });
      sendError(res, 500, "internal_error", "Failed to build OAuth URL");
    }
  }
});

// ── OAuth: Exchange Code for Token ───────────────────────────────────────────

hubspotRouter.post("/connect", requireRole("operator"), async (req, res) => {
  try {
    const config = getConfig();
    if (!ensureOAuthConfigured(config, res)) return;

    const { contractId, code, state, redirectUri } = validate(
      req.body,
      z.object({
        contractId: contractAddress,
        code: z.string().min(1),
        state: z.string().min(1),
        redirectUri: z.string().url(),
      })
    );

    const stateData = verifyOAuthState(state, config.clientSecret);
    if (!stateData) {
      sendError(res, 401, "invalid_state", "OAuth state is invalid or expired");
      return;
    }

    if (stateData.c !== contractId) {
      sendError(res, 401, "contract_mismatch", "OAuth state contract mismatch");
      return;
    }

    const tokenData = await exchangeCodeForToken({
      code,
      redirectUri,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
    });

    const cipher = createTokenCipher(config.tokenSecret);
    const encryptedAccess = encryptToken(
      { accessToken: tokenData.accessToken, expiresAt: tokenData.expiresAt },
      cipher.key
    );
    const encryptedRefresh = encryptToken(
      { refreshToken: tokenData.refreshToken },
      cipher.key
    );

    const connection = saveConnection({
      contractId,
      provider: HUBSPOT_PROVIDER,
      accessToken: encryptedAccess,
      refreshToken: encryptedRefresh,
      connectedBy: req.user?.address ?? "unknown",
    });

    addAuditLog({
      contractId,
      action: "crm_connect",
      actor: req.user?.address,
      payload: { provider: HUBSPOT_PROVIDER },
    });

    res.json({
      success: true,
      connection: sanitizeConnection(connection),
    });
  } catch (err) {
    if (err instanceof HubSpotError) {
      sendError(res, err.status, err.code, err.message);
    } else if (err.code === "validation_error") {
      sendError(res, 400, "invalid_request", err.message);
    } else {
      logger.error("Error connecting HubSpot", { error: err.message });
      sendError(res, 500, "internal_error", "Failed to connect HubSpot");
    }
  }
});

// ── OAuth: Disconnect ────────────────────────────────────────────────────────

hubspotRouter.post("/disconnect", requireRole("operator"), async (req, res) => {
  try {
    const { contractId } = validate(
      req.body,
      z.object({ contractId: contractAddress })
    );

    disconnectConnection(contractId, HUBSPOT_PROVIDER);

    addAuditLog({
      contractId,
      action: "crm_disconnect",
      actor: req.user?.address,
      payload: { provider: HUBSPOT_PROVIDER },
    });

    res.json({ success: true });
  } catch (err) {
    if (err.code === "validation_error") {
      sendError(res, 400, "invalid_request", err.message);
    } else {
      logger.error("Error disconnecting HubSpot", { error: err.message });
      sendError(res, 500, "internal_error", "Failed to disconnect HubSpot");
    }
  }
});

// ── Sync: Collaborators to Contacts ──────────────────────────────────────────

hubspotRouter.post("/sync-collaborators", requireRole("operator"), async (req, res) => {
  try {
    const config = getConfig();
    const { contractId } = validate(
      req.body,
      z.object({ contractId: contractAddress })
    );

    const { connection, accessToken } = await getAccessTokenForContract(contractId, config);
    
    if (!connection || !accessToken) {
      sendError(res, 404, "not_connected", "HubSpot connection not configured");
      return;
    }

    // Create API client
    const client = createHubSpotClient(accessToken);
    const syncId = startSync(contractId, HUBSPOT_PROVIDER, "collaborators");

    try {
      const collaborators = listKnownCollaborators(contractId);
      const errors = [];

      for (const collaborator of collaborators) {
        try {
          const props = buildContactProperties({
            firstName: collaborator.firstName || "Collaborator",
            lastName: collaborator.lastName || "",
            email: collaborator.email,
            stellarAddress: collaborator.address,
          }, config.fieldMap);

          if (Object.keys(props).length === 0) {
            incrementSyncProgress(syncId, "failed");
            errors.push(`No properties for ${collaborator.address}`);
            continue;
          }

          await client.upsertContact(collaborator.email || collaborator.address, props);

          const contactMapping = await client.getContact(collaborator.email || collaborator.address);
          if (contactMapping?.id) {
            upsertContactMapping(contractId, HUBSPOT_PROVIDER, {
              address: collaborator.address,
              externalId: contactMapping.id,
              syncDirection: "outbound",
              syncState: "synced",
            });
          }

          incrementSyncProgress(syncId, "success");
          recordCrmActivity(contractId, HUBSPOT_PROVIDER, "sync_contact_outbound", {
            collaboratorAddress: collaborator.address,
            status: "success",
          });
        } catch (err) {
          logger.error("Failed to sync collaborator to HubSpot", {
            contractId,
            address: collaborator.address,
            error: err.message,
          });
          incrementSyncProgress(syncId, "failed");
          errors.push(err.message);
          recordCrmActivity(contractId, HUBSPOT_PROVIDER, "sync_contact_outbound", {
            collaboratorAddress: collaborator.address,
            status: "failed",
            error: err.message,
          });
        }
      }

      finishSync(syncId, errors.length === 0 ? "completed" : "partial", errors);

      addAuditLog({
        contractId,
        action: "crm_sync_collaborators",
        actor: req.user?.address,
        payload: { provider: HUBSPOT_PROVIDER, totalCount: collaborators.length, errorCount: errors.length },
      });

      res.json({
        success: errors.length === 0,
        synced: collaborators.length - errors.length,
        failed: errors.length,
        errors,
      });
    } catch (err) {
      finishSync(syncId, "failed", [err.message]);
      logger.error("Sync collaborators to HubSpot failed", { error: err.message });
      sendError(res, 502, "sync_failed", "Failed to sync collaborators to HubSpot");
    }
  } catch (err) {
    if (err.code === "validation_error") {
      sendError(res, 400, "invalid_request", err.message);
    } else {
      logger.error("Error syncing collaborators", { error: err.message });
      sendError(res, 500, "internal_error", "Failed to sync collaborators");
    }
  }
});

// ── Sync: Create Deals for Large Payouts ─────────────────────────────────────

hubspotRouter.post("/sync-deals", requireRole("operator"), async (req, res) => {
  try {
    const config = getConfig();
    const { contractId, payouts } = validate(
      req.body,
      z.object({
        contractId: contractAddress,
        payouts: z.array(
          z.object({
            collaboratorAddress: stellarAddress,
            amount: z.number().positive(),
            timestamp: z.string().datetime().optional(),
          })
        ),
      })
    );

    const connection = getConnection(contractId, HUBSPOT_PROVIDER);
    if (!connection) {
      sendError(res, 404, "not_connected", "HubSpot connection not configured");
      return;
    }

    // Refresh token if needed
    let accessToken = null;
    try {
      const decrypted = decryptToken(connection.accessToken, createTokenCipher(config.tokenSecret).key);
      if (isTokenExpired(decrypted)) {
        const decryptedRefresh = decryptToken(connection.refreshToken, createTokenCipher(config.tokenSecret).key);
        const newToken = await refreshAccessToken({
          refreshToken: decryptedRefresh.refreshToken,
          clientId: config.clientId,
          clientSecret: config.clientSecret,
        });
        const cipher = createTokenCipher(config.tokenSecret);
        updateConnectionTokens(connection.id, {
          accessToken: encryptToken(newToken, cipher.key),
          refreshToken: encryptToken({ refreshToken: newToken.refreshToken }, cipher.key),
        });
        accessToken = newToken.accessToken;
      } else {
        accessToken = decrypted.accessToken;
      }
    } catch (err) {
      logger.error("Token decryption failed", { error: err.message });
      sendError(res, 502, "token_error", "Failed to decrypt HubSpot token");
      return;
    }

    const client = createHubSpotClient(accessToken);
    const createdDeals = [];
    const errors = [];

    for (const payout of payouts) {
      // Only create deals for payouts above threshold
      if (payout.amount < config.dealThreshold) {
        continue;
      }

      try {
        const dealProps = buildDealProperties({
          dealName: `Royalty Payout - ${payout.collaboratorAddress}`,
          amount: payout.amount,
          stage: HUBSPOT_DEAL_STAGES.PRESENTATION_SCHEDULED,
        });

        const deal = await client.createDeal(dealProps);

        // Associate contact to deal
        const contactMapping = getContactMappingByAddress(contractId, HUBSPOT_PROVIDER, payout.collaboratorAddress);
        if (contactMapping?.externalId) {
          await client.associateContactToDeal(contactMapping.externalId, deal.id);
        }

        createdDeals.push(deal.id);
        recordCrmActivity(contractId, HUBSPOT_PROVIDER, "create_deal", {
          collaboratorAddress: payout.collaboratorAddress,
          dealId: deal.id,
          amount: payout.amount,
          status: "success",
        });
      } catch (err) {
        logger.error("Failed to create HubSpot deal", {
          contractId,
          address: payout.collaboratorAddress,
          error: err.message,
        });
        errors.push(err.message);
        recordCrmActivity(contractId, HUBSPOT_PROVIDER, "create_deal", {
          collaboratorAddress: payout.collaboratorAddress,
          amount: payout.amount,
          status: "failed",
          error: err.message,
        });
      }
    }

    addAuditLog({
      contractId,
      action: "crm_sync_deals",
      actor: req.user?.address,
      payload: { provider: HUBSPOT_PROVIDER, createdCount: createdDeals.length },
    });

    res.json({
      success: errors.length === 0,
      createdDeals,
      failed: errors.length,
      errors,
    });
  } catch (err) {
    if (err.code === "validation_error") {
      sendError(res, 400, "invalid_request", err.message);
    } else {
      logger.error("Error syncing deals", { error: err.message });
      sendError(res, 500, "internal_error", "Failed to sync deals");
    }
  }
});

// ── Status: Report Connection and Sync Progress ──────────────────────────────

hubspotRouter.get("/sync-status", requireRole("operator"), async (req, res) => {
  try {
    const { contractId } = validate(
      req.query,
      z.object({ contractId: contractAddress })
    );

    const connection = getConnection(contractId, HUBSPOT_PROVIDER);
    const syncStatus = getSyncStatus(contractId, HUBSPOT_PROVIDER);

    res.json({
      connected: !!connection,
      connection: connection ? sanitizeConnection(connection) : null,
      syncStatus: syncStatus || { status: "never_synced" },
      recentActivities: connection ? listCrmActivities(contractId, HUBSPOT_PROVIDER, 10) : [],
    });
  } catch (err) {
    if (err.code === "validation_error") {
      sendError(res, 400, "invalid_request", err.message);
    } else {
      logger.error("Error fetching sync status", { error: err.message });
      sendError(res, 500, "internal_error", "Failed to fetch sync status");
    }
  }
});

// ── Webhook: Inbound Contact Updates ─────────────────────────────────────────

hubspotRouter.post("/webhook", async (req, res) => {
  try {
    const config = getConfig();
    if (!config.webhookSecret) {
      logger.warn("HubSpot webhook secret not configured");
      sendError(res, 503, "webhook_not_configured", "Webhook secret not configured");
      return;
    }

    const signature = req.headers["x-hubspot-signature"];
    if (!verifyWebhookSignature(req.rawBody || "", signature, config.webhookSecret)) {
      sendError(res, 401, "invalid_signature", "Webhook signature verification failed");
      return;
    }

    const { contractId, objectId, properties } = validate(
      req.body,
      z.object({
        contractId: contractAddress,
        objectId: z.string().min(1),
        properties: z.record(z.any()).optional(),
      })
    );

    const connection = getConnection(contractId, HUBSPOT_PROVIDER);
    if (!connection) {
      logger.warn("Received webhook for unconnected contract", { contractId });
      res.json({ received: true });
      return;
    }

    const contactMapping = findContactMappingByExternalId(contractId, HUBSPOT_PROVIDER, objectId);
    if (!contactMapping) {
      logger.warn("Received webhook for unknown contact", { contractId, objectId });
      res.json({ received: true });
      return;
    }

    // Map contact status to collaborator status (if applicable)
    if (properties?.status) {
      const statusMap = {
        "lead": "active",
        "active": "active",
        "inactive": "suspended",
        "blocked": "deactivated",
      };
      const newStatus = statusMap[properties.status.toLowerCase()] ?? "active";
      setContributorStatus(contractId, contactMapping.address, newStatus);

      recordCrmActivity(contractId, HUBSPOT_PROVIDER, "webhook_contact_update", {
        contactId: objectId,
        collaboratorAddress: contactMapping.address,
        newStatus,
      });
    }

    res.json({ received: true });
  } catch (err) {
    if (err.code === "validation_error") {
      logger.warn("Invalid webhook payload", { error: err.message });
      res.json({ received: false, error: "invalid_payload" });
    } else {
      logger.error("Error processing HubSpot webhook", { error: err.message });
      res.json({ received: false, error: "processing_error" });
    }
  }
});
