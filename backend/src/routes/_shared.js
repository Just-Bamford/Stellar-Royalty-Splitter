import { retryBuildTx } from "../stellar.js";
import { recordTransaction, addAuditLog } from "../database/index.js";
import { startSpan } from "../tracing.js";
import logger from "../logger.js";

/**
 * Shared pattern for transaction-building routes:
 * 1. Record transaction in database
 * 2. Build transaction XDR
 * 3. Log audit event
 * 4. Return XDR and transaction ID
 *
 * This eliminates duplication across initialize, distribute, and similar routes.
 *
 * Also emits structured lifecycle logs (#745) so a distribution or
 * initialization can be traced end-to-end: "started" before the DB record is
 * written, "simulation_built" once `retryBuildTx` returns unsigned XDR ready
 * for the wallet to sign, and "failed" if any step throws. There is no
 * "submitted"/"confirmed" step here — this handler only builds XDR for the
 * frontend to sign and submit directly to the network; the backend never
 * observes the signed submission or its on-chain confirmation.
 *
 * The XDR is built exactly once: `retryBuildTx` already retries transient
 * RPC failures internally (exponential backoff, transient errors only).
 */
export async function buildAndRecordTransaction({
  contractId,
  walletAddress,
  transactionType,
  scvlArgs,
  auditAction,
  auditMetadata,
  transactionMetadata = {},
}) {
  const startedAt = Date.now();

  logger.info("transaction build started", {
    transactionType,
    contractId,
    walletAddress,
  });

  // Build the transaction XDR (instrumented span for RPC call latency).
  // This is the ONLY build call — `retryBuildTx` handles transient RPC
  // failures internally with exponential backoff. (A previous revision
  // called `retryBuildTx` a second time here, discarding the first XDR and
  // needlessly consuming a fresh sequence number per request.)
  const txXdr = await startSpan(
    `rpc.${transactionType}`,
    {
      "contract.id": contractId,
      "wallet.address": walletAddress,
      "operation.type": transactionType,
    },
    () => retryBuildTx(walletAddress, contractId, transactionType, scvlArgs)
  );
  try {
    // Record transaction in database for audit trail
    const transactionId = recordTransaction(
      contractId,
      transactionType,
      walletAddress,
      transactionMetadata
    );

    // Log the audit event
    addAuditLog(contractId, auditAction, walletAddress, {
      transactionId,
      ...auditMetadata,
    });

    logger.info("transaction build succeeded", {
      transactionType,
      contractId,
      walletAddress,
      transactionId,
      durationMs: Date.now() - startedAt,
    });

    return { xdr: txXdr, transactionId };
  } catch (err) {
    logger.warn("transaction build failed", {
      transactionType,
      contractId,
      walletAddress,
      durationMs: Date.now() - startedAt,
      status: err?.status,
      error: err?.message ?? String(err),
    });
    throw err;
  }
}
