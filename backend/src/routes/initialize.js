import { Router } from "express";
import { addressToScVal, u32ToScVal, vecToScVal, isContractInitialized } from "../stellar.js";
import { validate, initializeSchema } from "../validation.js";
import { buildAndRecordTransaction } from "./_shared.js";
import { sendError } from "../error-response.js";

export const initializeRouter = Router();

/**
 * POST /api/initialize
 * Body: { contractId, walletAddress, collaborators: string[], shares: number[] }
 * Returns: { xdr, transactionId } — unsigned transaction XDR for the frontend to sign & submit + tracking ID
 */
initializeRouter.post("/", validate(initializeSchema), async (req, res, next) => {
  try {
    const { contractId, walletAddress, collaborators, shares } = req.body;

    if (!contractId || !walletAddress || !collaborators?.length || !shares?.length) {
      return sendError(res, 400, "bad_request", "Missing required fields.");
    }
    if (collaborators.length !== shares.length) {
      return sendError(res, 400, "bad_request", "Collaborators and shares arrays must be the same length");
    }
    const total = shares.reduce((s, n) => s + n, 0);
    if (total !== 10_000) {
      return sendError(res, 400, "bad_request", "Shares must sum to 10000 basis points");
    }

    // Check if contract is already initialized on-chain
    const alreadyInitialized = await isContractInitialized(contractId);
    if (alreadyInitialized) {
      return sendError(
        res,
        409,
        "conflict",
        "Contract is already initialized. Cannot re-initialize an existing contract."
      );
    }

    // Build ScVal arguments for the contract call
    const collaboratorVec = vecToScVal(collaborators.map(addressToScVal));
    const sharesVec = vecToScVal(shares.map(u32ToScVal));

    // Use shared handler to record transaction, build XDR, and log audit
    const { xdr, transactionId } = await buildAndRecordTransaction({
      contractId,
      walletAddress,
      transactionType: "initialize",
      scvlArgs: [collaboratorVec, sharesVec],
      auditAction: "contract_initialized",
      auditMetadata: {
        collaboratorCount: collaborators.length,
        shares,
      },
      transactionMetadata: {
        requestedAmount: null,
        tokenId: null,
      },
    });

    res.json({ xdr, transactionId });
  } catch (err) {
    if (err.status) {
      return sendError(res, err.status, undefined, err.message);
    }
    next(err);
  }
});
