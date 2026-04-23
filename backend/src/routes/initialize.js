import { Router } from "express";
import { buildTx, addressToScVal, u32ToScVal, vecToScVal } from "../stellar.js";
import { recordTransaction, addAuditLog } from "../database.js";
import { validate, initializeSchema } from "../validation.js";

export const initializeRouter = Router();

/**
 * POST /api/initialize
 * Body: { contractId, walletAddress, collaborators: string[], shares: number[] }
 * Returns: { xdr, transactionId } — unsigned transaction XDR for the frontend to sign & submit + tracking ID
 */
initializeRouter.post("/", validate(initializeSchema), async (req, res, next) => {
  try {
    const { contractId, walletAddress, collaborators, shares } = req.body;

    if (
      !contractId ||
      !walletAddress ||
      !collaborators?.length ||
      !shares?.length
    ) {
      return res.status(400).json({ error: "Missing required fields." });
    }
    if (collaborators.length !== shares.length) {
      return res
        .status(400)
        .json({ error: "collaborators and shares length mismatch." });
    }
    const total = shares.reduce((s, n) => s + n, 0);
    if (total !== 10_000) {
      return res
        .status(400)
        .json({ error: `Shares must sum to 10000 bp (got ${total}).` });
    }

    // Record transaction in database for audit trail
    const transactionId = recordTransaction(
      contractId,
      "initialize",
      walletAddress,
      { collaboratorCount: collaborators.length },
    );

    const collaboratorVec = vecToScVal(collaborators.map(addressToScVal));
    const sharesVec = vecToScVal(shares.map(u32ToScVal));

    const txXdr = await buildTx(walletAddress, contractId, "initialize", [
      collaboratorVec,
      sharesVec,
    ]);

    // Log the initialization
    addAuditLog(contractId, "contract_initialized", walletAddress, {
      transactionId,
      collaboratorCount: collaborators.length,
      shares,
    });

    res.json({ xdr: txXdr, transactionId });
  } catch (err) {
    next(err);
  }
});
