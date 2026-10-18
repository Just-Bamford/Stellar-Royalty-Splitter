/**
 * QuickBooks accounting sync routes — closes #940.
 *
 * Mounted at /api/v1/accounting/quickbooks. Only /webhook is reachable without
 * an admin API key (QuickBooks posts to it server-to-server).
 *
 *   POST /connect              Initiate OAuth (returns authUrl) or, when a
 *                              `code` is supplied, complete the exchange and
 *                              persist the connection.
 *   POST /sync-distributions   Push unsynced distributions to QuickBooks as
 *                              invoices (per collaborator payout) and journal
 *                              entries (fee / royalty pool transfers).
 *   POST /webhook              QuickBooks subscription receiver — invoice paid
 *                              events mark the matching sync item confirmed.
 *   GET  /status               Connection state + last sync run summary.
 */

import { Router } from "express";
import { z } from "zod";
import logger from "../../logger.js";
import { sendError } from "../../error-response.js";
import { requirePermission } from "../../middleware/rbac-check.js";
import { PERMISSIONS } from "../../models/rbac.js";
import { addAuditLog } from "../../database/audit.js";
import { recordAuditEvent } from "../../services/audit-trail.js";
import {
  ensureAccountingSyncTables,
  getQuickBooksConnection,
  getUnsyncedDistributionTransactions,
  getDistributionTransactionById,
  getDistributionPayouts,
  createAccountingSync,
  updateAccountingSyncStatus,
  addAccountingSyncItem,
  markAccountingSyncItemSynced,
  markAccountingSyncItemFailed,
  markAccountingSyncItemConfirmed,
  getAccountingSync,
  getLatestAccountingSync,
  getRecentAccountingSyncs,
  redeemQuickBooksOAuthState,
  getAccountingSyncItems,
} from "../../database/accounting-sync.js";
import {
  buildAuthUrl,
  exchangeCodeForToken,
  createInvoice,
  createJournalEntry,
  verifyWebhookSignature,
  parseWebhookPayload,
  isInvoicePaid,
} from "../../services/quickbooks.js";

export const quickbooksRouter = Router();

ensureAccountingSyncTables();

const connectSchema = z.object({
  code: z.string().min(1).optional(),
  realmId: z.string().min(1).optional(),
  state: z.string().min(1).optional(),
});

const syncSchema = z.object({
  transactionIds: z.array(z.number().int().positive()).max(500).optional(),
});

/**
 * POST /api/v1/accounting/quickbooks/connect
 *
 * Without a body: returns { authUrl, state } to send the admin to Intuit's
 * consent screen. With { code, realmId, state }: completes the OAuth exchange.
 */
quickbooksRouter.post("/connect", requirePermission(PERMISSIONS.SETTINGS_UPDATE), async (req, res) => {
  try {
    const parsed = connectSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      const issues = parsed.error.issues.map((e) => ({
        field: e.path.join("."),
        message: e.message,
      }));
      return sendError(res, 400, "validation_failed", issues[0]?.message ?? "Validation failed", {
        details: issues,
      });
    }
    const { code, realmId, state } = parsed.data;

    if (!code) {
      const { authUrl, state: oauthState } = await buildAuthUrl();
      return res.json({ success: true, data: { authUrl, state: oauthState } });
    }

    if (state && !redeemQuickBooksOAuthState(state)) {
      return sendError(res, 400, "invalid_oauth_state", "OAuth state token is invalid or expired");
    }

    const connection = await exchangeCodeForToken({ code, realmId });
    addAuditLog(
      connection.realmId ?? "quickbooks",
      "quickbooks_connected",
      req.headers["x-api-key"] ?? "admin",
      { realmId: connection.realmId }
    );

    return res.status(201).json({
      success: true,
      data: {
        connected: true,
        realmId: connection.realmId,
        expiresAt: connection.expiresAt,
      },
    });
  } catch (err) {
    logger.error("QuickBooks connect failed", {
      realmId: req.body?.realmId ?? null,
      error: err.message ?? String(err),
      code: err.code,
    });
    if (err.status) return sendError(res, err.status, err.code, err.message);
    return sendError(res, 500, "internal_server_error", err.message ?? "Connection failed");
  }
});

/**
 * GET /api/v1/accounting/quickbooks/callback
 *
 * OAuth redirect destination configured as QUICKBOOKS_REDIRECT_URI. Exchanges
 * `code` + `realm_id`, then redirects the browser back to the frontend.
 */
quickbooksRouter.get("/callback", async (req, res) => {
  try {
    const { code, realm_id: realmId, state, error } = req.query;
    if (error) {
      return res.redirect(`${process.env.FRONTEND_ORIGIN ?? "http://localhost:5173"}?quickbooks=denied`);
    }
    if (!code || typeof code !== "string") {
      return sendError(res, 400, "invalid_oauth_callback", "Missing OAuth code");
    }
    if (state && !redeemQuickBooksOAuthState(String(state))) {
      return sendError(res, 400, "invalid_oauth_state", "OAuth state token is invalid or expired");
    }

    const connection = await exchangeCodeForToken({
      code,
      realmId: typeof realmId === "string" ? realmId : undefined,
    });
    addAuditLog(connection.realmId ?? "quickbooks", "quickbooks_connected", "oauth-callback", {
      realmId: connection.realmId,
    });

    const origin = process.env.FRONTEND_ORIGIN ?? "http://localhost:5173";
    return res.redirect(`${origin}?quickbooks=connected`);
  } catch (err) {
    logger.error("QuickBooks OAuth callback failed", { error: err.message ?? String(err) });
    if (err.status) return sendError(res, err.status, err.code, err.message);
    return sendError(res, 500, "internal_server_error", err.message ?? "OAuth callback failed");
  }
});

/**
 * POST /api/v1/accounting/quickbooks/sync-distributions
 *
 * For every unsynced distribution transaction: create one QuickBooks invoice
 * per collaborator payout and one journal entry for the royalty pool transfer,
 * tracking per-entity status. Idempotent: already-synced distributions are
 * skipped. Optionally restrict with { transactionIds }.
 */
quickbooksRouter.post("/sync-distributions", requirePermission(PERMISSIONS.FINANCIALS_EXPORT), async (req, res) => {
  try {
    const parsed = syncSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      const issues = parsed.error.issues.map((e) => ({
        field: e.path.join("."),
        message: e.message,
      }));
      return sendError(res, 400, "validation_failed", issues[0]?.message ?? "Validation failed", {
        details: issues,
      });
    }
    const { transactionIds } = parsed.data;

    const connection = getQuickBooksConnection();
    const realmId = connection?.realm_id ?? process.env.QUICKBOOKS_REALM_ID ?? null;
    if (!realmId) {
      return sendError(
        res,
        409,
        "quickbooks_not_connected",
        "Connect a QuickBooks company before syncing distributions"
      );
    }

    const distributions = transactionIds?.length
      ? transactionIds.map((id) => getDistributionTransactionById(id)).filter(Boolean)
      : getUnsyncedDistributionTransactions(500);

    if (distributions.length === 0) {
      return res.json({
        success: true,
        data: {
          synced: 0,
          invoicesCreated: 0,
          journalEntriesCreated: 0,
          message: "No unsynced distributions found",
        },
      });
    }

    const sync = createAccountingSync({ realmId, syncType: "distributions", totalItems: 0 });

    let successCount = 0;
    let failureCount = 0;
    let invoicesCreated = 0;
    let journalEntriesCreated = 0;

    for (const distribution of distributions) {
      const payouts = getDistributionPayouts(distribution.id);

      // Invoice per collaborator payout
      for (const payout of payouts) {
        let item = addAccountingSyncItem({
          syncId: sync.id,
          transactionId: distribution.id,
          kind: "invoice",
          recipient: payout.collaboratorAddress,
          amount: payout.amountReceived,
        });
        try {
          const invoice = await createInvoice({
            recipient: payout.collaboratorAddress,
            amount: payout.amountReceived,
            memo: `Stellar distribution ${distribution.id} royalty payout`,
            realmId,
            invoiceNumber: `SRS-${distribution.id}-${payout.collaboratorAddress.slice(0, 6)}`,
          });
          markAccountingSyncItemSynced(item.id, invoice.id);
          successCount += 1;
          invoicesCreated += 1;
        } catch (invoiceErr) {
          markAccountingSyncItemFailed(item.id, invoiceErr.message ?? String(invoiceErr));
          failureCount += 1;
        }
      }

      // Journal entry for the fee / royalty pool transfer
      let entry = addAccountingSyncItem({
        syncId: sync.id,
        transactionId: distribution.id,
        kind: "journal_entry",
        amount: distribution.requestedAmount ?? distribution.totalPayout,
        detail: "Royalty pool / distribution fees transfer",
      });
      try {
        const journal = await createJournalEntry({
          amount: distribution.requestedAmount ?? distribution.totalPayout,
          memo: `distribution ${distribution.id}`,
          realmId,
        });
        markAccountingSyncItemSynced(entry.id, journal.id);
        successCount += 1;
        journalEntriesCreated += 1;
      } catch (journalErr) {
        markAccountingSyncItemFailed(entry.id, journalErr.message ?? String(journalErr));
        failureCount += 1;
      }
    }

    const finalStatus = failureCount === 0 ? "completed" : successCount > 0 ? "partial" : "failed";
    const finished = updateAccountingSyncStatus({
      syncId: sync.id,
      status: finalStatus,
      successCount,
      failureCount,
      errorMessage: failureCount > 0 ? `${failureCount} item(s) failed to sync` : null,
      summary: {
        distributions: distributions.length,
        invoicesCreated,
        journalEntriesCreated,
      },
    });

    addAuditLog(realmId, "quickbooks_distributions_synced", req.headers["x-api-key"] ?? "admin", {
      syncId: sync.id,
      distributions: distributions.length,
      invoicesCreated,
      journalEntriesCreated,
      successCount,
      failureCount,
    });

    recordAuditEvent({
      eventType: "quickbooks_distributions_synced",
      actor: req.headers["x-api-key"] ?? "admin",
      contractId: realmId,
      payload: { syncId: sync.id, invoicesCreated, journalEntriesCreated, failureCount },
    });

    return res.json({
      success: true,
      data: {
        syncId: sync.id,
        status: finished.status,
        distributions: distributions.length,
        invoicesCreated,
        journalEntriesCreated,
        successCount,
        failureCount,
      },
    });
  } catch (err) {
    logger.error("QuickBooks distribution sync failed", { error: err.message ?? String(err) });
    if (err.status) return sendError(res, err.status, err.code, err.message);
    return sendError(res, 500, "internal_server_error", err.message ?? "Sync failed");
  }
});

/**
 * POST /api/v1/accounting/quickbooks/webhook
 *
 * QuickBooks subscription delivery endpoint. Signature is verified with the
 * verifier token; Invoice Create/Update operations are resolved against the
 * QuickBooks API; fully paid invoices mark the matching sync item confirmed.
 * Returns 200 as quickly as possible regardless of outcome (Intuit retries
 * non-2xx), and the operation is processed in the background after respond.
 */
quickbooksRouter.post(
  "/webhook",
  (req, res, next) => {
    const signature = req.get("intuit-signature") ?? "";
    if (!verifyWebhookSignature(req.rawBody ?? JSON.stringify(req.body ?? {}), signature)) {
      return sendError(res, 401, "invalid_signature", "QuickBooks webhook signature verification failed");
    }
    next();
  },
  (req, res) => {
    // Acknowledge immediately; QuickBooks times out after a few seconds.
    res.status(200).json({ success: true });

    const entities = parseWebhookPayload(req.body ?? {});
    if (entities.length === 0) {
      logger.warn("QuickBooks webhook received with no entity notifications");
      return;
    }

    processWebhookEntities(entities).catch((err) => {
      logger.error("QuickBooks webhook processing failed", {
        error: err.message ?? String(err),
      });
    });
  }
);

/**
 * GET /api/v1/accounting/quickbooks/status
 */
quickbooksRouter.get("/status", requirePermission(PERMISSIONS.FINANCIALS_READ), (_req, res) => {
  try {
    const connection = getQuickBooksConnection();
    const latestSync = getLatestAccountingSync("distributions");
    const recentSyncs = getRecentAccountingSyncs(10);

    res.json({
      success: true,
      data: {
        connected: connection?.status === "connected",
        connection: connection
          ? {
              realmId: connection.realm_id,
              status: connection.status,
              connectedAt: connection.connected_at,
              errorMessage: connection.error_message ?? null,
              tokenExpiresAt: connection.token_expires_at ?? null,
            }
          : null,
        latestSync: latestSync ? serializeSync(latestSync) : null,
        recentSyncs: recentSyncs.map(serializeSync),
      },
    });
  } catch (err) {
    logger.error("QuickBooks status fetch failed", { error: err.message ?? String(err) });
    return sendError(res, 500, "internal_server_error", err.message ?? "Status fetch failed");
  }
});

/**
 * GET /api/v1/accounting/quickbooks/syncs/:syncId
 */
quickbooksRouter.get("/syncs/:syncId", requirePermission(PERMISSIONS.FINANCIALS_READ), (req, res) => {
  const syncId = parseInt(req.params.syncId, 10);
  if (!Number.isInteger(syncId) || syncId <= 0) {
    return sendError(res, 400, "invalid_sync_id", "Invalid sync id");
  }
  const sync = getAccountingSync(syncId);
  if (!sync) return sendError(res, 404, "not_found", "Sync run not found");
  const items = getAccountingSyncItems(syncId);
  return res.json({ success: true, data: { sync: serializeSync(sync), items } });
});

// ─── Helpers ───────────────────────────────────────────────────────────────────

function serializeSync(sync) {
  const summary = parseJsonSafe(sync.summary);
  return {
    id: sync.id,
    realmId: sync.realm_id,
    syncType: sync.sync_type,
    status: sync.status,
    totalItems: sync.total_items,
    successCount: sync.success_count,
    failureCount: sync.failure_count,
    errorMessage: sync.error_message ?? null,
    summary,
    startedAt: sync.started_at ?? null,
    completedAt: sync.completed_at ?? null,
    itemCount: sync.item_count ?? 0,
  };
}

function parseJsonSafe(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

async function processWebhookEntities(entities) {
  for (const entity of entities) {
    if (entity.type !== "Invoice") continue;
    try {
      const paid = await isInvoicePaid(entity.id, entity.realmId);
      if (paid) {
        const updated = markAccountingSyncItemConfirmed(entity.id);
        if (!updated) {
          logger.info("QuickBooks invoice has no matching sync item", { invoiceId: entity.id });
          continue;
        }
        logger.info("QuickBooks invoice paid — sync item confirmed", {
          invoiceId: entity.id,
          syncItemId: updated.id,
          transactionId: updated.transaction_id,
        });
        addAuditLog(
          entity.realmId ?? "quickbooks",
          "quickbooks_invoice_paid",
          "quickbooks-webhook",
          {
            invoiceId: entity.id,
            syncItemId: updated.id,
            transactionId: updated.transaction_id,
          }
        );
      }
    } catch (err) {
      logger.error("QuickBooks webhook invoice lookup failed", {
        invoiceId: entity.id,
        error: err.message ?? String(err),
      });
    }
  }
}
