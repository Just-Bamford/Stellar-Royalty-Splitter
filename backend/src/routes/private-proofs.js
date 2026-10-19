import { Router } from "express";
import {
  createPrivateProof,
  listPrivateProofs,
  verifyPrivateProof,
} from "../database/private-proofs.js";
import { sendError } from "../error-response.js";

export const privateProofsRouter = Router();
const walletPattern = /^G[A-Z2-7]{55}$/;

privateProofsRouter.post("/", (req, res) => {
  try {
    const { walletAddress, proofType, witness, publicSignals = [] } = req.body ?? {};
    if (!walletPattern.test(walletAddress ?? ""))
      return sendError(res, 400, "invalid_wallet_address", "Invalid wallet address");
    const data = createPrivateProof({ walletAddress, proofType, witness, publicSignals });
    return res.status(201).json({ success: true, data });
  } catch (error) {
    return sendError(res, 400, "invalid_proof", error.message);
  }
});

privateProofsRouter.post("/verify", (req, res) => {
  const { proof, commitment, proofType, publicSignals = [] } = req.body ?? {};
  return res.json({
    success: true,
    data: verifyPrivateProof({ proof, commitment, proofType, publicSignals }),
  });
});

privateProofsRouter.get("/:walletAddress", (req, res) => {
  if (!walletPattern.test(req.params.walletAddress))
    return sendError(res, 400, "invalid_wallet_address", "Invalid wallet address");
  return res.json({ success: true, data: listPrivateProofs(req.params.walletAddress) });
});
