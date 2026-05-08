import { retryBuildTx } from "../stellar.js";
import { recordTransaction, addAuditLog } from "../database/index.js";

/**
 * Shared pattern for transaction-building routes:
 * 1. Record transaction in database
 * 2. Build transaction XDR
 * 3. Log audit event
 * 4. Return XDR and transaction ID
 *
 * This eliminates duplication across initialize, distribute, and similar routes.
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
  // Record transaction in database for audit trail
  const transactionId = recordTransaction(
    contractId,
    transactionType,
    walletAddress,
    transactionMetadata
  );

  // Build the transaction XDR
  const txXdr = await retryBuildTx(walletAddress, contractId, transactionType, scvlArgs);

  // Log the audit event
  addAuditLog(contractId, auditAction, walletAddress, {
    transactionId,
    ...auditMetadata,
  });

  return { xdr: txXdr, transactionId };
}
