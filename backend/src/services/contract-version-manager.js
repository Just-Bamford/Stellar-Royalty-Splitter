/**
 * Smart Contract Versioning and Gradual Migration System
 * 
 * Supports multi-stage contract upgrades with:
 * - Stage 1: Deploy v2 WASM, keep v1 active (shadow mode)
 * - Stage 2: Route percentage of new collaborators to v2 (canary testing)
 * - Stage 3: Bidirectional state sync (v1 ↔ v2)
 * - Stage 4: Complete migration to v2
 */

import db from "../database.js";
import { logger } from "../logger.js";

export const MIGRATION_STAGES = Object.freeze({
  SHADOW: "shadow",           // v2 deployed, v1 active
  CANARY: "canary",           // Route X% to v2
  SYNC: "sync",               // Bidirectional sync active
  COMPLETE: "complete",       // All on v2
  ROLLBACK: "rollback"        // Emergency rollback to v1
});

export const CANARY_PERCENTAGES = [5, 10, 25, 50, 75, 100];

// Initialize contract versions table
function ensureVersionTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS contract_versions (
      contractId TEXT NOT NULL,
      version INTEGER NOT NULL,
      wasmHash TEXT NOT NULL,
      deployedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      stage TEXT NOT NULL DEFAULT 'shadow',
      canaryPercent INTEGER NOT NULL DEFAULT 0,
      isActive BOOLEAN NOT NULL DEFAULT 0,
      metadata TEXT,
      PRIMARY KEY (contractId, version)
    );
    
    CREATE TABLE IF NOT EXISTS contract_migration_state (
      contractId TEXT PRIMARY KEY,
      currentVersion INTEGER NOT NULL,
      targetVersion INTEGER,
      migrationStage TEXT NOT NULL,
      canaryPercent INTEGER NOT NULL DEFAULT 0,
      syncEnabled BOOLEAN NOT NULL DEFAULT 0,
      startedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completedAt TEXT,
      rollbackReason TEXT,
      metrics TEXT
    );
    
    CREATE TABLE IF NOT EXISTS contract_version_routing (
      contractId TEXT NOT NULL,
      collaboratorAddress TEXT NOT NULL,
      routedVersion INTEGER NOT NULL,
      routedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      reason TEXT,
      PRIMARY KEY (contractId, collaboratorAddress)
    );
    
    CREATE INDEX IF NOT EXISTS idx_version_routing ON contract_version_routing(contractId, routedVersion);
  `);
}

/**
 * Deploy a new contract version in shadow mode
 */
export function deployContractVersion(contractId, version, wasmHash, metadata = {}) {
  ensureVersionTable();
  
  const existing = db.prepare(
    "SELECT version FROM contract_versions WHERE contractId = ? AND version = ?"
  ).get(contractId, version);
  
  if (existing) {
    throw new Error(`Version ${version} already exists for contract ${contractId}`);
  }
  
  const currentActive = db.prepare(
    "SELECT version FROM contract_versions WHERE contractId = ? AND isActive = 1"
  ).get(contractId);
  
  const isActive = !currentActive; // First version is automatically active
  
  db.prepare(`
    INSERT INTO contract_versions (contractId, version, wasmHash, stage, isActive, metadata)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(contractId, version, wasmHash, MIGRATION_STAGES.SHADOW, isActive ? 1 : 0, JSON.stringify(metadata));
  
  logger.info(`Deployed contract version ${version} for ${contractId} in shadow mode`);
  
  return {
    contractId,
    version,
    wasmHash,
    stage: MIGRATION_STAGES.SHADOW,
    isActive,
    deployedAt: new Date().toISOString()
  };
}

/**
 * Start canary migration - route X% of new collaborators to target version
 */
export function startCanaryMigration(contractId, targetVersion, canaryPercent = 5) {
  ensureVersionTable();
  
  if (!CANARY_PERCENTAGES.includes(canaryPercent)) {
    throw new Error(`Invalid canary percent. Must be one of: ${CANARY_PERCENTAGES.join(", ")}`);
  }
  
  const currentVersion = db.prepare(
    "SELECT version FROM contract_versions WHERE contractId = ? AND isActive = 1"
  ).get(contractId);
  
  if (!currentVersion) {
    throw new Error(`No active version found for contract ${contractId}`);
  }
  
  const targetExists = db.prepare(
    "SELECT version FROM contract_versions WHERE contractId = ? AND version = ?"
  ).get(contractId, targetVersion);
  
  if (!targetExists) {
    throw new Error(`Target version ${targetVersion} not found for contract ${contractId}`);
  }
  
  // Update migration state
  db.prepare(`
    INSERT OR REPLACE INTO contract_migration_state 
    (contractId, currentVersion, targetVersion, migrationStage, canaryPercent, syncEnabled, startedAt)
    VALUES (?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP)
  `).run(contractId, currentVersion.version, targetVersion, MIGRATION_STAGES.CANARY, canaryPercent);
  
  // Update target version stage
  db.prepare(`
    UPDATE contract_versions SET stage = ? WHERE contractId = ? AND version = ?
  `).run(MIGRATION_STAGES.CANARY, contractId, targetVersion);
  
  logger.info(`Started canary migration for ${contractId}: ${canaryPercent}% to v${targetVersion}`);
  
  return {
    contractId,
    currentVersion: currentVersion.version,
    targetVersion,
    canaryPercent,
    stage: MIGRATION_STAGES.CANARY
  };
}

/**
 * Route a collaborator to appropriate contract version based on canary percentage
 */
export function routeCollaborator(contractId, collaboratorAddress, isNewCollaborator = true) {
  ensureVersionTable();
  
  // Check if already routed
  const existing = db.prepare(
    "SELECT routedVersion FROM contract_version_routing WHERE contractId = ? AND collaboratorAddress = ?"
  ).get(contractId, collaboratorAddress);
  
  if (existing) {
    return { version: existing.routedVersion, reason: "existing_routing" };
  }
  
  const migrationState = db.prepare(
    "SELECT * FROM contract_migration_state WHERE contractId = ?"
  ).get(contractId);
  
  if (!migrationState || migrationState.migrationStage === MIGRATION_STAGES.SHADOW) {
    // No active migration or shadow mode - use current version
    const currentVersion = db.prepare(
      "SELECT version FROM contract_versions WHERE contractId = ? AND isActive = 1"
    ).get(contractId);
    return { version: currentVersion?.version || 1, reason: "no_migration" };
  }
  
  if (migrationState.migrationStage === MIGRATION_STAGES.COMPLETE) {
    // Migration complete - everyone on target version
    return { version: migrationState.targetVersion, reason: "migration_complete" };
  }
  
  // Canary routing logic
  if (isNewCollaborator && migrationState.migrationStage === MIGRATION_STAGES.CANARY) {
    const random = Math.random() * 100;
    const routedVersion = random < migrationState.canaryPercent 
      ? migrationState.targetVersion 
      : migrationState.currentVersion;
    
    const reason = random < migrationState.canaryPercent ? "canary_selected" : "canary_not_selected";
    
    // Record routing decision
    db.prepare(`
      INSERT INTO contract_version_routing (contractId, collaboratorAddress, routedVersion, reason)
      VALUES (?, ?, ?, ?)
    `).run(contractId, collaboratorAddress, routedVersion, reason);
    
    return { version: routedVersion, reason };
  }
  
  // Default to current version
  return { version: migrationState.currentVersion, reason: "default" };
}

/**
 * Increase canary percentage
 */
export function increaseCanaryPercentage(contractId, newPercent) {
  ensureVersionTable();
  
  if (!CANARY_PERCENTAGES.includes(newPercent)) {
    throw new Error(`Invalid canary percent. Must be one of: ${CANARY_PERCENTAGES.join(", ")}`);
  }
  
  const migrationState = db.prepare(
    "SELECT * FROM contract_migration_state WHERE contractId = ?"
  ).get(contractId);
  
  if (!migrationState || migrationState.migrationStage !== MIGRATION_STAGES.CANARY) {
    throw new Error(`Contract ${contractId} is not in canary migration stage`);
  }
  
  if (newPercent <= migrationState.canaryPercent) {
    throw new Error(`New percent (${newPercent}) must be greater than current (${migrationState.canaryPercent})`);
  }
  
  db.prepare(`
    UPDATE contract_migration_state SET canaryPercent = ? WHERE contractId = ?
  `).run(newPercent, contractId);
  
  logger.info(`Increased canary percentage for ${contractId} to ${newPercent}%`);
  
  return { contractId, canaryPercent: newPercent };
}

/**
 * Enable bidirectional state sync between versions
 */
export function enableStateSync(contractId) {
  ensureVersionTable();
  
  const migrationState = db.prepare(
    "SELECT * FROM contract_migration_state WHERE contractId = ?"
  ).get(contractId);
  
  if (!migrationState) {
    throw new Error(`No migration in progress for contract ${contractId}`);
  }
  
  db.prepare(`
    UPDATE contract_migration_state 
    SET syncEnabled = 1, migrationStage = ?
    WHERE contractId = ?
  `).run(MIGRATION_STAGES.SYNC, contractId);
  
  logger.info(`Enabled bidirectional state sync for ${contractId}`);
  
  return { contractId, syncEnabled: true, stage: MIGRATION_STAGES.SYNC };
}

/**
 * Complete migration - make target version active
 */
export function completeMigration(contractId) {
  ensureVersionTable();
  
  const migrationState = db.prepare(
    "SELECT * FROM contract_migration_state WHERE contractId = ?"
  ).get(contractId);
  
  if (!migrationState) {
    throw new Error(`No migration in progress for contract ${contractId}`);
  }
  
  const transaction = db.transaction(() => {
    // Deactivate old version
    db.prepare(`
      UPDATE contract_versions SET isActive = 0, stage = 'deprecated'
      WHERE contractId = ? AND version = ?
    `).run(contractId, migrationState.currentVersion);
    
    // Activate new version
    db.prepare(`
      UPDATE contract_versions SET isActive = 1, stage = ?
      WHERE contractId = ? AND version = ?
    `).run(MIGRATION_STAGES.COMPLETE, contractId, migrationState.targetVersion);
    
    // Update migration state
    db.prepare(`
      UPDATE contract_migration_state 
      SET migrationStage = ?, completedAt = CURRENT_TIMESTAMP
      WHERE contractId = ?
    `).run(MIGRATION_STAGES.COMPLETE, contractId);
  });
  
  transaction();
  
  logger.info(`Completed migration for ${contractId} to v${migrationState.targetVersion}`);
  
  return {
    contractId,
    newActiveVersion: migrationState.targetVersion,
    stage: MIGRATION_STAGES.COMPLETE
  };
}

/**
 * Rollback to previous version
 */
export function rollbackMigration(contractId, reason = "manual_rollback") {
  ensureVersionTable();
  
  const migrationState = db.prepare(
    "SELECT * FROM contract_migration_state WHERE contractId = ?"
  ).get(contractId);
  
  if (!migrationState) {
    throw new Error(`No migration in progress for contract ${contractId}`);
  }
  
  const transaction = db.transaction(() => {
    // Update migration state
    db.prepare(`
      UPDATE contract_migration_state 
      SET migrationStage = ?, rollbackReason = ?, completedAt = CURRENT_TIMESTAMP
      WHERE contractId = ?
    `).run(MIGRATION_STAGES.ROLLBACK, reason, contractId);
    
    // Reset target version stage to shadow
    db.prepare(`
      UPDATE contract_versions SET stage = ?
      WHERE contractId = ? AND version = ?
    `).run(MIGRATION_STAGES.SHADOW, contractId, migrationState.targetVersion);
    
    // Clear routing for target version
    db.prepare(`
      DELETE FROM contract_version_routing 
      WHERE contractId = ? AND routedVersion = ?
    `).run(contractId, migrationState.targetVersion);
  });
  
  transaction();
  
  logger.warn(`Rolled back migration for ${contractId}: ${reason}`);
  
  return {
    contractId,
    activeVersion: migrationState.currentVersion,
    stage: MIGRATION_STAGES.ROLLBACK,
    reason
  };
}

/**
 * Get migration statistics
 */
export function getMigrationStats(contractId) {
  ensureVersionTable();
  
  const migrationState = db.prepare(
    "SELECT * FROM contract_migration_state WHERE contractId = ?"
  ).get(contractId);
  
  if (!migrationState) {
    return null;
  }
  
  const routingStats = db.prepare(`
    SELECT 
      routedVersion,
      COUNT(*) as count,
      reason
    FROM contract_version_routing
    WHERE contractId = ?
    GROUP BY routedVersion, reason
  `).all(contractId);
  
  const versions = db.prepare(`
    SELECT * FROM contract_versions WHERE contractId = ? ORDER BY version DESC
  `).all(contractId);
  
  return {
    contractId,
    currentVersion: migrationState.currentVersion,
    targetVersion: migrationState.targetVersion,
    stage: migrationState.migrationStage,
    canaryPercent: migrationState.canaryPercent,
    syncEnabled: migrationState.syncEnabled === 1,
    startedAt: migrationState.startedAt,
    completedAt: migrationState.completedAt,
    routingStats,
    versions: versions.map(v => ({
      version: v.version,
      wasmHash: v.wasmHash,
      stage: v.stage,
      isActive: v.isActive === 1,
      deployedAt: v.deployedAt
    }))
  };
}
