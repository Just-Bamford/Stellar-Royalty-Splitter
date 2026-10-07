/**
 * Advanced Smart Contract Versioning and Gradual Migration System
 * Issue #963 - Multi-stage contract versioning with canary testing
 */

const logger = require('../logger');
const db = require('../database');
const { stellar } = require('../stellar');

/**
 * Contract version states
 */
const VersionState = {
  SHADOW: 'shadow', // Deployed but not active
  CANARY: 'canary', // Active for small percentage of users
  ACTIVE: 'active', // Fully active
  DEPRECATED: 'deprecated', // Old version, being phased out
  RETIRED: 'retired', // No longer in use
};

/**
 * Migration stages for gradual rollout
 */
const MigrationStage = {
  STAGE_1_SHADOW: 'stage_1_shadow', // Deploy v2, keep v1 active
  STAGE_2_CANARY_5: 'stage_2_canary_5', // Route 5% to v2
  STAGE_3_CANARY_25: 'stage_3_canary_25', // Route 25% to v2
  STAGE_4_CANARY_50: 'stage_4_canary_50', // Route 50% to v2
  STAGE_5_FULL: 'stage_5_full', // 100% to v2
  STAGE_6_RETIRE_V1: 'stage_6_retire_v1', // Retire v1
};

class ContractVersioningService {
  constructor() {
    this.initializeDatabase();
  }

  /**
   * Initialize database tables for versioning
   */
  initializeDatabase() {
    const createVersionsTable = `
      CREATE TABLE IF NOT EXISTS contract_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        version_id TEXT UNIQUE NOT NULL,
        contract_id TEXT NOT NULL,
        wasm_hash TEXT NOT NULL,
        state TEXT NOT NULL,
        deployed_at INTEGER NOT NULL,
        deployed_by TEXT NOT NULL,
        metadata TEXT,
        created_at INTEGER DEFAULT (strftime('%s', 'now'))
      )
    `;

    const createMigrationStagesTable = `
      CREATE TABLE IF NOT EXISTS migration_stages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        migration_id TEXT UNIQUE NOT NULL,
        from_version TEXT NOT NULL,
        to_version TEXT NOT NULL,
        current_stage TEXT NOT NULL,
        rollout_percentage INTEGER DEFAULT 0,
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        status TEXT NOT NULL,
        metrics TEXT,
        created_at INTEGER DEFAULT (strftime('%s', 'now'))
      )
    `;

    const createVersionRoutingTable = `
      CREATE TABLE IF NOT EXISTS version_routing (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        contract_base_id TEXT NOT NULL,
        user_address TEXT NOT NULL,
        assigned_version TEXT NOT NULL,
        assignment_reason TEXT,
        assigned_at INTEGER NOT NULL,
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        UNIQUE(contract_base_id, user_address)
      )
    `;

    const createVersionMetricsTable = `
      CREATE TABLE IF NOT EXISTS version_metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        version_id TEXT NOT NULL,
        metric_name TEXT NOT NULL,
        metric_value REAL NOT NULL,
        recorded_at INTEGER NOT NULL,
        metadata TEXT,
        created_at INTEGER DEFAULT (strftime('%s', 'now'))
      )
    `;

    try {
      db.prepare(createVersionsTable).run();
      db.prepare(createMigrationStagesTable).run();
      db.prepare(createVersionRoutingTable).run();
      db.prepare(createVersionMetricsTable).run();

      // Create indexes
      db.prepare('CREATE INDEX IF NOT EXISTS idx_versions_contract ON contract_versions(contract_id, state)').run();
      db.prepare('CREATE INDEX IF NOT EXISTS idx_routing_user ON version_routing(user_address)').run();
      db.prepare('CREATE INDEX IF NOT EXISTS idx_metrics_version ON version_metrics(version_id, recorded_at)').run();

      logger.info('Contract versioning database initialized');
    } catch (error) {
      logger.error('Failed to initialize versioning database', error);
      throw error;
    }
  }

  /**
   * Deploy a new contract version in shadow mode
   */
  deployShadowVersion(contractId, wasmHash, deployedBy, metadata = {}) {
    const versionId = `v${Date.now()}`;
    const deployedAt = Math.floor(Date.now() / 1000);

    const stmt = db.prepare(`
      INSERT INTO contract_versions (version_id, contract_id, wasm_hash, state, deployed_at, deployed_by, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      versionId,
      contractId,
      wasmHash,
      VersionState.SHADOW,
      deployedAt,
      deployedBy,
      JSON.stringify(metadata)
    );

    logger.info(`Deployed shadow version ${versionId} for contract ${contractId}`);

    return {
      versionId,
      contractId,
      wasmHash,
      state: VersionState.SHADOW,
      deployedAt,
      metadata,
    };
  }

  /**
   * Start gradual migration with canary testing
   */
  startMigration(fromVersion, toVersion, initialPercentage = 5) {
    const migrationId = `migration-${Date.now()}`;
    const startedAt = Math.floor(Date.now() / 1000);

    // Update from_version state to deprecated
    db.prepare('UPDATE contract_versions SET state = ? WHERE version_id = ?')
      .run(VersionState.DEPRECATED, fromVersion);

    // Update to_version state to canary
    db.prepare('UPDATE contract_versions SET state = ? WHERE version_id = ?')
      .run(VersionState.CANARY, toVersion);

    // Create migration record
    const stmt = db.prepare(`
      INSERT INTO migration_stages (migration_id, from_version, to_version, current_stage, rollout_percentage, started_at, status)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    let stage;
    if (initialPercentage === 5) {
      stage = MigrationStage.STAGE_2_CANARY_5;
    } else if (initialPercentage === 25) {
      stage = MigrationStage.STAGE_3_CANARY_25;
    } else if (initialPercentage === 50) {
      stage = MigrationStage.STAGE_4_CANARY_50;
    } else {
      stage = MigrationStage.STAGE_2_CANARY_5;
      initialPercentage = 5;
    }

    stmt.run(migrationId, fromVersion, toVersion, stage, initialPercentage, startedAt, 'in_progress');

    logger.info(`Started migration ${migrationId}: ${fromVersion} -> ${toVersion} at ${initialPercentage}%`);

    return {
      migrationId,
      fromVersion,
      toVersion,
      stage,
      rolloutPercentage: initialPercentage,
      status: 'in_progress',
    };
  }

  /**
   * Route user to appropriate contract version based on migration stage
   */
  routeUserToVersion(contractBaseId, userAddress, migrationId = null) {
    // Check if user already has an assignment
    const existingAssignment = db.prepare(`
      SELECT assigned_version FROM version_routing
      WHERE contract_base_id = ? AND user_address = ?
    `).get(contractBaseId, userAddress);

    if (existingAssignment) {
      return existingAssignment.assigned_version;
    }

    // Get active migration
    const migration = migrationId
      ? db.prepare('SELECT * FROM migration_stages WHERE migration_id = ? AND status = ?')
          .get(migrationId, 'in_progress')
      : db.prepare('SELECT * FROM migration_stages WHERE status = ? ORDER BY started_at DESC LIMIT 1')
          .get('in_progress');

    if (!migration) {
      // No active migration, use active version
      const activeVersion = db.prepare(`
        SELECT version_id FROM contract_versions
        WHERE contract_id = ? AND state = ?
        ORDER BY deployed_at DESC LIMIT 1
      `).get(contractBaseId, VersionState.ACTIVE);

      return activeVersion?.version_id || null;
    }

    // Deterministic assignment based on user address hash
    const userHash = this.hashUserAddress(userAddress);
    const userPercentile = userHash % 100;

    let assignedVersion;
    let reason;

    if (userPercentile < migration.rollout_percentage) {
      assignedVersion = migration.to_version;
      reason = `canary_${migration.rollout_percentage}pct`;
    } else {
      assignedVersion = migration.from_version;
      reason = 'stable';
    }

    // Store assignment
    const assignedAt = Math.floor(Date.now() / 1000);
    db.prepare(`
      INSERT INTO version_routing (contract_base_id, user_address, assigned_version, assignment_reason, assigned_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(contract_base_id, user_address) DO UPDATE SET
        assigned_version = excluded.assigned_version,
        assignment_reason = excluded.assignment_reason,
        assigned_at = excluded.assigned_at
    `).run(contractBaseId, userAddress, assignedVersion, reason, assignedAt);

    logger.info(`Routed user ${userAddress.slice(0, 8)}... to version ${assignedVersion} (${reason})`);

    return assignedVersion;
  }

  /**
   * Progress migration to next stage
   */
  progressMigration(migrationId, nextPercentage) {
    const migration = db.prepare('SELECT * FROM migration_stages WHERE migration_id = ?')
      .get(migrationId);

    if (!migration) {
      throw new Error(`Migration ${migrationId} not found`);
    }

    let nextStage;
    if (nextPercentage === 25) {
      nextStage = MigrationStage.STAGE_3_CANARY_25;
    } else if (nextPercentage === 50) {
      nextStage = MigrationStage.STAGE_4_CANARY_50;
    } else if (nextPercentage === 100) {
      nextStage = MigrationStage.STAGE_5_FULL;
    } else {
      throw new Error(`Invalid percentage: ${nextPercentage}`);
    }

    db.prepare(`
      UPDATE migration_stages
      SET current_stage = ?, rollout_percentage = ?
      WHERE migration_id = ?
    `).run(nextStage, nextPercentage, migrationId);

    if (nextPercentage === 100) {
      // Mark to_version as active
      db.prepare('UPDATE contract_versions SET state = ? WHERE version_id = ?')
        .run(VersionState.ACTIVE, migration.to_version);

      // Mark from_version as deprecated
      db.prepare('UPDATE contract_versions SET state = ? WHERE version_id = ?')
        .run(VersionState.DEPRECATED, migration.from_version);
    }

    logger.info(`Progressed migration ${migrationId} to ${nextStage} (${nextPercentage}%)`);

    return { migrationId, stage: nextStage, rolloutPercentage: nextPercentage };
  }

  /**
   * Complete migration and retire old version
   */
  completeMigration(migrationId) {
    const migration = db.prepare('SELECT * FROM migration_stages WHERE migration_id = ?')
      .get(migrationId);

    if (!migration) {
      throw new Error(`Migration ${migrationId} not found`);
    }

    const completedAt = Math.floor(Date.now() / 1000);

    db.prepare(`
      UPDATE migration_stages
      SET current_stage = ?, status = ?, completed_at = ?, rollout_percentage = 100
      WHERE migration_id = ?
    `).run(MigrationStage.STAGE_6_RETIRE_V1, 'completed', completedAt, migrationId);

    // Retire old version
    db.prepare('UPDATE contract_versions SET state = ? WHERE version_id = ?')
      .run(VersionState.RETIRED, migration.from_version);

    logger.info(`Completed migration ${migrationId}, retired ${migration.from_version}`);

    return { migrationId, status: 'completed', completedAt };
  }

  /**
   * Rollback migration
   */
  rollbackMigration(migrationId, reason) {
    const migration = db.prepare('SELECT * FROM migration_stages WHERE migration_id = ?')
      .get(migrationId);

    if (!migration) {
      throw new Error(`Migration ${migrationId} not found`);
    }

    db.prepare(`
      UPDATE migration_stages
      SET status = ?, metrics = ?
      WHERE migration_id = ?
    `).run('rolled_back', JSON.stringify({ reason, rolledBackAt: Date.now() }), migrationId);

    // Restore from_version to active
    db.prepare('UPDATE contract_versions SET state = ? WHERE version_id = ?')
      .run(VersionState.ACTIVE, migration.from_version);

    // Set to_version back to shadow
    db.prepare('UPDATE contract_versions SET state = ? WHERE version_id = ?')
      .run(VersionState.SHADOW, migration.to_version);

    // Clear routing assignments
    db.prepare('DELETE FROM version_routing WHERE assigned_version = ?')
      .run(migration.to_version);

    logger.warn(`Rolled back migration ${migrationId}: ${reason}`);

    return { migrationId, status: 'rolled_back', reason };
  }

  /**
   * Record version metric for monitoring
   */
  recordMetric(versionId, metricName, metricValue, metadata = {}) {
    const recordedAt = Math.floor(Date.now() / 1000);

    db.prepare(`
      INSERT INTO version_metrics (version_id, metric_name, metric_value, recorded_at, metadata)
      VALUES (?, ?, ?, ?, ?)
    `).run(versionId, metricName, metricValue, recordedAt, JSON.stringify(metadata));
  }

  /**
   * Get version metrics for comparison
   */
  getVersionMetrics(versionId, metricName, since = null) {
    let query = `
      SELECT metric_value, recorded_at, metadata
      FROM version_metrics
      WHERE version_id = ? AND metric_name = ?
    `;

    const params = [versionId, metricName];

    if (since) {
      query += ' AND recorded_at >= ?';
      params.push(since);
    }

    query += ' ORDER BY recorded_at DESC LIMIT 1000';

    return db.prepare(query).all(...params);
  }

  /**
   * Get migration status
   */
  getMigrationStatus(migrationId) {
    const migration = db.prepare('SELECT * FROM migration_stages WHERE migration_id = ?')
      .get(migrationId);

    if (!migration) {
      return null;
    }

    // Get user distribution
    const distribution = db.prepare(`
      SELECT assigned_version, COUNT(*) as count
      FROM version_routing
      WHERE assigned_version IN (?, ?)
      GROUP BY assigned_version
    `).all(migration.from_version, migration.to_version);

    // Get recent metrics for both versions
    const fromMetrics = this.getVersionMetrics(migration.from_version, 'error_rate');
    const toMetrics = this.getVersionMetrics(migration.to_version, 'error_rate');

    return {
      ...migration,
      metrics: JSON.parse(migration.metrics || '{}'),
      distribution,
      versionMetrics: {
        from: fromMetrics.slice(0, 10),
        to: toMetrics.slice(0, 10),
      },
    };
  }

  /**
   * Hash user address for deterministic routing
   */
  hashUserAddress(address) {
    let hash = 0;
    for (let i = 0; i < address.length; i++) {
      const char = address.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash);
  }

  /**
   * Get all versions for a contract
   */
  getContractVersions(contractId) {
    return db.prepare(`
      SELECT * FROM contract_versions
      WHERE contract_id = ?
      ORDER BY deployed_at DESC
    `).all(contractId);
  }

  /**
   * Get active migrations
   */
  getActiveMigrations() {
    return db.prepare(`
      SELECT * FROM migration_stages
      WHERE status = 'in_progress'
      ORDER BY started_at DESC
    `).all();
  }
}

module.exports = new ContractVersioningService();
