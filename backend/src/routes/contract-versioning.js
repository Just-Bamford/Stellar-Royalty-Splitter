import { Router } from "express";
import {
  deployContractVersion,
  startCanaryMigration,
  increaseCanaryPercentage,
  enableStateSync,
  completeMigration,
  rollbackMigration,
  getMigrationStats,
  routeCollaborator,
  MIGRATION_STAGES,
  CANARY_PERCENTAGES
} from "../services/contract-version-manager.js";

export const contractVersioningRouter = Router();

// Deploy new contract version
contractVersioningRouter.post("/contracts/:contractId/versions", (req, res, next) => {
  try {
    const { version, wasmHash, metadata } = req.body;
    
    if (!version || !wasmHash) {
      return res.status(400).json({ 
        success: false, 
        error: "version and wasmHash are required" 
      });
    }
    
    const result = deployContractVersion(
      req.params.contractId, 
      parseInt(version), 
      wasmHash, 
      metadata || {}
    );
    
    res.status(201).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

// Start canary migration
contractVersioningRouter.post("/contracts/:contractId/migrations/canary", (req, res, next) => {
  try {
    const { targetVersion, canaryPercent = 5 } = req.body;
    
    if (!targetVersion) {
      return res.status(400).json({ 
        success: false, 
        error: "targetVersion is required" 
      });
    }
    
    const result = startCanaryMigration(
      req.params.contractId, 
      parseInt(targetVersion), 
      canaryPercent
    );
    
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

// Increase canary percentage
contractVersioningRouter.patch("/contracts/:contractId/migrations/canary", (req, res, next) => {
  try {
    const { canaryPercent } = req.body;
    
    if (!canaryPercent) {
      return res.status(400).json({ 
        success: false, 
        error: "canaryPercent is required" 
      });
    }
    
    const result = increaseCanaryPercentage(req.params.contractId, canaryPercent);
    
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

// Enable bidirectional state sync
contractVersioningRouter.post("/contracts/:contractId/migrations/sync", (req, res, next) => {
  try {
    const result = enableStateSync(req.params.contractId);
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

// Complete migration
contractVersioningRouter.post("/contracts/:contractId/migrations/complete", (req, res, next) => {
  try {
    const result = completeMigration(req.params.contractId);
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

// Rollback migration
contractVersioningRouter.post("/contracts/:contractId/migrations/rollback", (req, res, next) => {
  try {
    const { reason = "manual_rollback" } = req.body;
    const result = rollbackMigration(req.params.contractId, reason);
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

// Get migration statistics
contractVersioningRouter.get("/contracts/:contractId/migrations/stats", (req, res, next) => {
  try {
    const stats = getMigrationStats(req.params.contractId);
    
    if (!stats) {
      return res.status(404).json({ 
        success: false, 
        error: "No migration found for this contract" 
      });
    }
    
    res.json({ success: true, data: stats });
  } catch (error) {
    next(error);
  }
});

// Route collaborator (used internally during operations)
contractVersioningRouter.post("/contracts/:contractId/route-collaborator", (req, res, next) => {
  try {
    const { collaboratorAddress, isNewCollaborator = true } = req.body;
    
    if (!collaboratorAddress) {
      return res.status(400).json({ 
        success: false, 
        error: "collaboratorAddress is required" 
      });
    }
    
    const result = routeCollaborator(
      req.params.contractId, 
      collaboratorAddress, 
      isNewCollaborator
    );
    
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

// Get available migration stages and canary percentages (reference data)
contractVersioningRouter.get("/contracts/migrations/reference", (req, res) => {
  res.json({ 
    success: true, 
    data: {
      stages: Object.values(MIGRATION_STAGES),
      canaryPercentages: CANARY_PERCENTAGES
    }
  });
});
