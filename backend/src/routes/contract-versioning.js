/**
 * API Routes for Contract Versioning and Migration
 * Issue #963
 */

const express = require('express');
const router = express.Router();
const versioningService = require('../services/contract-versioning');
const { errorResponse } = require('../error-response');
const logger = require('../logger');

/**
 * POST /api/v1/versioning/deploy-shadow
 * Deploy a new contract version in shadow mode
 */
router.post('/deploy-shadow', async (req, res) => {
  try {
    const { contractId, wasmHash, deployedBy, metadata } = req.body;

    if (!contractId || !wasmHash || !deployedBy) {
      return res.status(400).json(
        errorResponse('validation_failed', 'contractId, wasmHash, and deployedBy are required')
      );
    }

    const result = versioningService.deployShadowVersion(
      contractId,
      wasmHash,
      deployedBy,
      metadata || {}
    );

    logger.info(`Shadow version deployed: ${result.versionId}`);

    res.status(201).json({
      success: true,
      version: result,
    });
  } catch (error) {
    logger.error('Failed to deploy shadow version', error);
    res.status(500).json(errorResponse('deployment_failed', error.message));
  }
});

/**
 * POST /api/v1/versioning/start-migration
 * Start gradual migration from one version to another
 */
router.post('/start-migration', async (req, res) => {
  try {
    const { fromVersion, toVersion, initialPercentage = 5 } = req.body;

    if (!fromVersion || !toVersion) {
      return res.status(400).json(
        errorResponse('validation_failed', 'fromVersion and toVersion are required')
      );
    }

    if (initialPercentage < 0 || initialPercentage > 100) {
      return res.status(400).json(
        errorResponse('validation_failed', 'initialPercentage must be between 0 and 100')
      );
    }

    const result = versioningService.startMigration(fromVersion, toVersion, initialPercentage);

    logger.info(`Migration started: ${result.migrationId}`);

    res.status(201).json({
      success: true,
      migration: result,
    });
  } catch (error) {
    logger.error('Failed to start migration', error);
    res.status(500).json(errorResponse('migration_start_failed', error.message));
  }
});

/**
 * POST /api/v1/versioning/progress-migration
 * Progress migration to next stage
 */
router.post('/progress-migration', async (req, res) => {
  try {
    const { migrationId, nextPercentage } = req.body;

    if (!migrationId || nextPercentage === undefined) {
      return res.status(400).json(
        errorResponse('validation_failed', 'migrationId and nextPercentage are required')
      );
    }

    const result = versioningService.progressMigration(migrationId, nextPercentage);

    logger.info(`Migration progressed: ${migrationId} to ${nextPercentage}%`);

    res.json({
      success: true,
      migration: result,
    });
  } catch (error) {
    logger.error('Failed to progress migration', error);
    res.status(500).json(errorResponse('migration_progress_failed', error.message));
  }
});

/**
 * POST /api/v1/versioning/complete-migration
 * Complete migration and retire old version
 */
router.post('/complete-migration', async (req, res) => {
  try {
    const { migrationId } = req.body;

    if (!migrationId) {
      return res.status(400).json(
        errorResponse('validation_failed', 'migrationId is required')
      );
    }

    const result = versioningService.completeMigration(migrationId);

    logger.info(`Migration completed: ${migrationId}`);

    res.json({
      success: true,
      migration: result,
    });
  } catch (error) {
    logger.error('Failed to complete migration', error);
    res.status(500).json(errorResponse('migration_complete_failed', error.message));
  }
});

/**
 * POST /api/v1/versioning/rollback-migration
 * Rollback an in-progress migration
 */
router.post('/rollback-migration', async (req, res) => {
  try {
    const { migrationId, reason } = req.body;

    if (!migrationId || !reason) {
      return res.status(400).json(
        errorResponse('validation_failed', 'migrationId and reason are required')
      );
    }

    const result = versioningService.rollbackMigration(migrationId, reason);

    logger.warn(`Migration rolled back: ${migrationId} - ${reason}`);

    res.json({
      success: true,
      migration: result,
    });
  } catch (error) {
    logger.error('Failed to rollback migration', error);
    res.status(500).json(errorResponse('migration_rollback_failed', error.message));
  }
});

/**
 * GET /api/v1/versioning/route/:contractId/:userAddress
 * Route user to appropriate version
 */
router.get('/route/:contractId/:userAddress', (req, res) => {
  try {
    const { contractId, userAddress } = req.params;
    const { migrationId } = req.query;

    if (!contractId || !userAddress) {
      return res.status(400).json(
        errorResponse('validation_failed', 'contractId and userAddress are required')
      );
    }

    const assignedVersion = versioningService.routeUserToVersion(
      contractId,
      userAddress,
      migrationId || null
    );

    res.json({
      contractId,
      userAddress,
      assignedVersion,
    });
  } catch (error) {
    logger.error('Failed to route user to version', error);
    res.status(500).json(errorResponse('routing_failed', error.message));
  }
});

/**
 * GET /api/v1/versioning/migration/:migrationId
 * Get migration status
 */
router.get('/migration/:migrationId', (req, res) => {
  try {
    const { migrationId } = req.params;

    const status = versioningService.getMigrationStatus(migrationId);

    if (!status) {
      return res.status(404).json(
        errorResponse('migration_not_found', `Migration ${migrationId} not found`)
      );
    }

    res.json({
      success: true,
      migration: status,
    });
  } catch (error) {
    logger.error('Failed to get migration status', error);
    res.status(500).json(errorResponse('status_retrieval_failed', error.message));
  }
});

/**
 * GET /api/v1/versioning/migrations
 * Get all active migrations
 */
router.get('/migrations', (req, res) => {
  try {
    const migrations = versioningService.getActiveMigrations();

    res.json({
      success: true,
      migrations,
      count: migrations.length,
    });
  } catch (error) {
    logger.error('Failed to get active migrations', error);
    res.status(500).json(errorResponse('migrations_retrieval_failed', error.message));
  }
});

/**
 * GET /api/v1/versioning/versions/:contractId
 * Get all versions for a contract
 */
router.get('/versions/:contractId', (req, res) => {
  try {
    const { contractId } = req.params;

    const versions = versioningService.getContractVersions(contractId);

    res.json({
      success: true,
      contractId,
      versions,
      count: versions.length,
    });
  } catch (error) {
    logger.error('Failed to get contract versions', error);
    res.status(500).json(errorResponse('versions_retrieval_failed', error.message));
  }
});

/**
 * POST /api/v1/versioning/record-metric
 * Record a metric for version monitoring
 */
router.post('/record-metric', (req, res) => {
  try {
    const { versionId, metricName, metricValue, metadata } = req.body;

    if (!versionId || !metricName || metricValue === undefined) {
      return res.status(400).json(
        errorResponse('validation_failed', 'versionId, metricName, and metricValue are required')
      );
    }

    versioningService.recordMetric(versionId, metricName, metricValue, metadata || {});

    res.json({
      success: true,
      message: 'Metric recorded',
    });
  } catch (error) {
    logger.error('Failed to record metric', error);
    res.status(500).json(errorResponse('metric_recording_failed', error.message));
  }
});

/**
 * GET /api/v1/versioning/metrics/:versionId/:metricName
 * Get metrics for a version
 */
router.get('/metrics/:versionId/:metricName', (req, res) => {
  try {
    const { versionId, metricName } = req.params;
    const { since } = req.query;

    const metrics = versioningService.getVersionMetrics(
      versionId,
      metricName,
      since ? parseInt(since, 10) : null
    );

    res.json({
      success: true,
      versionId,
      metricName,
      metrics,
      count: metrics.length,
    });
  } catch (error) {
    logger.error('Failed to get version metrics', error);
    res.status(500).json(errorResponse('metrics_retrieval_failed', error.message));
  }
});

module.exports = router;
