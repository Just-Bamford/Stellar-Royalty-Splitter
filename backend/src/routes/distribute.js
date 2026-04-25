import { Router } from "express";
import { retryBuildTx, addressToScVal } from "../stellar.js";
import { recordTransaction, addAuditLog } from "../database.js";
import { validate, distributeSchema } from "../validation.js";

export const distributeRouter = Router();

/**
 * POST /api/distribute
 * Body: { contractId, walletAddress, tokenId }
 * Returns: { xdr, transactionId } — unsigned transaction XDR + tracking ID
 */
distributeRouter.post("/", validate(distributeSchema), async (req, res, next) => {
  try {
    const { contractId, walletAddress, tokenId } = req.body;

    const transactionId = recordTransaction(
      contractId,
      "distribute",
      walletAddress,
      { tokenId },
    );

    const txXdr = await retryBuildTx(walletAddress, contractId, "distribute", [
      addressToScVal(tokenId),
    ]);

    addAuditLog(contractId, "distribution_initiated", walletAddress, {
      transactionId,
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
