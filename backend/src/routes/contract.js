import { Router } from "express";
import { isContractInitialized } from "../stellar.js";

export const contractRouter = Router();

contractRouter.get("/status/:contractId", async (req, res, next) => {
  try {
    const { contractId } = req.params;
    if (!contractId || !/^C[A-Z2-7]{55}$/.test(contractId)) {
      return res.status(400).json({ error: "Invalid contract ID" });
    }
    const initialized = await isContractInitialized(contractId);
    res.json({ initialized });
  } catch (err) {
    next(err);
  }
});
