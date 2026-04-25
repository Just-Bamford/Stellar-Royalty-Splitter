import { Router } from "express";
import { retryBuildTx, addressToScVal, i128ToScVal } from "../stellar.js";
import { recordTransaction, addAuditLog } from "../database.js";
import { validate, distributeSchema } from "../validation.js";

export const distributeRouter = Router();

/**
 * POST /api/distribute
 * Body: { contractId, walletAddress, tokenId, amount }
 * Returns: { xdr, transactionId } — unsigned transaction XDR + tracking ID
 */
distributeRouter.post("/", validate(distributeSchema), async (req, res, next) => {
  try {
    const { contractId, walletAddress, tokenId, amount } = req.body;

    if (!contractId || !walletAddress) {
      return res.status(400).json({ error: "Missing required fields." });
    }
    if (!tokenId) {
      return res.status(400).json({ error: "Token ID is required" });
    }
    if (typeof amount !== "number" || amount <= 0) {
      return res.status(400).json({ error: "Amount must be a positive number" });
    }

    // Record transaction in database for audit trail
    const transactionId = recordTransaction(
      contractId,
      "distribute",
      walletAddress,
      { requestedAmount: amount.toString(), tokenId },
    );

    const txXdr = await retryBuildTx(walletAddress, contractId, "distribute", [
      addressToScVal(tokenId),
      i128ToScVal(amount),
    ]);

    // Log the distribution request
    addAuditLog(contractId, "distribution_initiated", walletAddress, {
      transactionId,
      amount: amount.toString(),
      tokenId,
    });

    res.json({ xdr: txXdr, transactionId });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.message });
    }
    next(err);
  }
});
