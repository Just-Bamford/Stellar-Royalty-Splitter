import { Router } from "express";
import { addressToScVal } from "../stellar.js";
import { validate, distributeSchema } from "../validation.js";
import { buildAndRecordTransaction } from "./_shared.js";

export const distributeRouter = Router();

/**
 * POST /api/distribute
 * Body: { contractId, walletAddress, tokenId }
 * Returns: { xdr, transactionId } — unsigned transaction XDR + tracking ID
 */
distributeRouter.post("/", validate(distributeSchema), async (req, res, next) => {
  try {
    const { contractId, walletAddress, tokenId } = req.body;

    // Use shared handler to record transaction, build XDR, and log audit
    const { xdr, transactionId } = await buildAndRecordTransaction({
      contractId,
      walletAddress,
      transactionType: "distribute",
      scvlArgs: [addressToScVal(tokenId)],
      auditAction: "distribution_initiated",
      auditMetadata: { tokenId },
      transactionMetadata: { tokenId },
    });

    res.json({ xdr, transactionId });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.message });
    }
    next(err);
  }
});
