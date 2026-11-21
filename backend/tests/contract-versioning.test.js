/**
 * Tests for Contract Versioning and Migration System
 * Issue #963
 */

import request from 'supertest';
import express from 'express';
import versioningRoutes from '../src/routes/contract-versioning.js';
import versioningService from '../src/services/contract-versioning.js';

const app = express();
app.use(express.json());
app.use('/api/v1/versioning', versioningRoutes);

describe('Contract Versioning System', () => {
  let testContractId;
  let testVersion1;
  let testVersion2;
  let testMigrationId;

  beforeAll(() => {
    testContractId = 'CTEST123CONTRACT';
  });

  describe('Shadow Deployment', () => {
    const validWasmHash1 = 'a'.repeat(64);
    const validWasmHash2 = 'b'.repeat(64);

    it('should deploy a new version in shadow mode', async () => {
      const response = await request(app)
        .post('/api/v1/versioning/deploy-shadow')
        .send({
          contractId: testContractId,
          wasmHash: validWasmHash1,
          deployedBy: 'GDEPLOYER',
          metadata: { description: 'Test version 1' },
        });

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.version).toHaveProperty('versionId');
      expect(response.body.version.state).toBe('shadow');

      testVersion1 = response.body.version.versionId;
    });

    it('should reject deployment without required fields', async () => {
      const response = await request(app)
        .post('/api/v1/versioning/deploy-shadow')
        .send({
          contractId: testContractId,
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('validation_failed');
    });

    it('should reject deployment with invalid wasmHash format', async () => {
      // Too short
      const resShort = await request(app)
        .post('/api/v1/versioning/deploy-shadow')
        .send({
          contractId: testContractId,
          wasmHash: 'abc123',
          deployedBy: 'GDEPLOYER',
        });
      expect(resShort.status).toBe(400);
      expect(resShort.body.error).toBe('validation_failed');
      expect(resShort.body.message).toBe('wasmHash must be a 64-character hex string');

      // Non-hex characters
      const resNonHex = await request(app)
        .post('/api/v1/versioning/deploy-shadow')
        .send({
          contractId: testContractId,
          wasmHash: 'z'.repeat(64),
          deployedBy: 'GDEPLOYER',
        });
      expect(resNonHex.status).toBe(400);
      expect(resNonHex.body.error).toBe('validation_failed');
      expect(resNonHex.body.message).toBe('wasmHash must be a 64-character hex string');

      // Too long (65 chars)
      const resLong = await request(app)
        .post('/api/v1/versioning/deploy-shadow')
        .send({
          contractId: testContractId,
          wasmHash: 'a'.repeat(65),
          deployedBy: 'GDEPLOYER',
        });
      expect(resLong.status).toBe(400);
      expect(resLong.body.error).toBe('validation_failed');
    });

    it('should reject deployment with invalid contractId or deployedBy', async () => {
      const resBlankContract = await request(app)
        .post('/api/v1/versioning/deploy-shadow')
        .send({
          contractId: '   ',
          wasmHash: validWasmHash1,
          deployedBy: 'GDEPLOYER',
        });
      expect(resBlankContract.status).toBe(400);
      expect(resBlankContract.body.error).toBe('validation_failed');

      const resBlankDeployer = await request(app)
        .post('/api/v1/versioning/deploy-shadow')
        .send({
          contractId: testContractId,
          wasmHash: validWasmHash1,
          deployedBy: '   ',
        });
      expect(resBlankDeployer.status).toBe(400);
      expect(resBlankDeployer.body.error).toBe('validation_failed');
    });

    it('should deploy a second version', async () => {
      const response = await request(app)
        .post('/api/v1/versioning/deploy-shadow')
        .send({
          contractId: testContractId,
          wasmHash: validWasmHash2,
          deployedBy: 'GDEPLOYER',
          metadata: { description: 'Test version 2' },
        });

      expect(response.status).toBe(201);
      testVersion2 = response.body.version.versionId;
    });
  });

  describe('Migration Start', () => {
    it('should start migration with canary rollout', async () => {
      const response = await request(app)
        .post('/api/v1/versioning/start-migration')
        .send({
          fromVersion: testVersion1,
          toVersion: testVersion2,
          initialPercentage: 5,
        });

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.migration.rolloutPercentage).toBe(5);
      expect(response.body.migration.status).toBe('in_progress');

      testMigrationId = response.body.migration.migrationId;
    });

    it('should reject invalid percentage', async () => {
      const response = await request(app)
        .post('/api/v1/versioning/start-migration')
        .send({
          fromVersion: testVersion1,
          toVersion: testVersion2,
          initialPercentage: 150,
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('validation_failed');
    });
  });

  describe('User Routing', () => {
    it('should route users deterministically based on percentage', async () => {
      const usersToTest = 100;
      const routedToV2 = [];
      const routedToV1 = [];

      for (let i = 0; i < usersToTest; i++) {
        const userAddress = `GUSER${String(i).padStart(3, '0')}`;
        const response = await request(app)
          .get(`/api/v1/versioning/route/${testContractId}/${userAddress}`)
          .query({ migrationId: testMigrationId });

        expect(response.status).toBe(200);
        expect(response.body.assignedVersion).toBeDefined();

        if (response.body.assignedVersion === testVersion2) {
          routedToV2.push(userAddress);
        } else {
          routedToV1.push(userAddress);
        }
      }

      // Should be approximately 5% to v2
      const v2Percentage = (routedToV2.length / usersToTest) * 100;
      expect(v2Percentage).toBeGreaterThanOrEqual(1);
      expect(v2Percentage).toBeLessThanOrEqual(10);
    });

    it('should return same version for same user', async () => {
      const userAddress = 'GCONSISTENTUSER';

      const response1 = await request(app)
        .get(`/api/v1/versioning/route/${testContractId}/${userAddress}`)
        .query({ migrationId: testMigrationId });

      const response2 = await request(app)
        .get(`/api/v1/versioning/route/${testContractId}/${userAddress}`)
        .query({ migrationId: testMigrationId });

      expect(response1.body.assignedVersion).toBe(response2.body.assignedVersion);
    });
  });

  describe('Migration Progression', () => {
    it('should progress migration to 25%', async () => {
      const response = await request(app)
        .post('/api/v1/versioning/progress-migration')
        .send({
          migrationId: testMigrationId,
          nextPercentage: 25,
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.migration.rolloutPercentage).toBe(25);
    });

    it('should progress migration to 50%', async () => {
      const response = await request(app)
        .post('/api/v1/versioning/progress-migration')
        .send({
          migrationId: testMigrationId,
          nextPercentage: 50,
        });

      expect(response.status).toBe(200);
      expect(response.body.migration.rolloutPercentage).toBe(50);
    });

    it('should progress migration to 100%', async () => {
      const response = await request(app)
        .post('/api/v1/versioning/progress-migration')
        .send({
          migrationId: testMigrationId,
          nextPercentage: 100,
        });

      expect(response.status).toBe(200);
      expect(response.body.migration.rolloutPercentage).toBe(100);
    });
  });

  describe('Migration Status', () => {
    it('should retrieve migration status', async () => {
      const response = await request(app)
        .get(`/api/v1/versioning/migration/${testMigrationId}`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.migration).toHaveProperty('migration_id');
      expect(response.body.migration).toHaveProperty('distribution');
    });

    it('should return 404 for non-existent migration', async () => {
      const response = await request(app)
        .get('/api/v1/versioning/migration/nonexistent-migration');

      expect(response.status).toBe(404);
    });
  });

  describe('Metrics Recording', () => {
    it('should record version metrics', async () => {
      const response = await request(app)
        .post('/api/v1/versioning/record-metric')
        .send({
          versionId: testVersion2,
          metricName: 'error_rate',
          metricValue: 0.02,
          metadata: { source: 'test' },
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it('should retrieve version metrics', async () => {
      const response = await request(app)
        .get(`/api/v1/versioning/metrics/${testVersion2}/error_rate`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.metrics).toBeInstanceOf(Array);
    });
  });

  describe('Version Listing', () => {
    it('should list all versions for a contract', async () => {
      const response = await request(app)
        .get(`/api/v1/versioning/versions/${testContractId}`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.versions).toBeInstanceOf(Array);
      expect(response.body.count).toBeGreaterThanOrEqual(2);
    });

    it('should list active migrations', async () => {
      const response = await request(app)
        .get('/api/v1/versioning/migrations');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.migrations).toBeInstanceOf(Array);
    });
  });

  describe('Migration Completion', () => {
    it('should complete migration and retire old version', async () => {
      const response = await request(app)
        .post('/api/v1/versioning/complete-migration')
        .send({
          migrationId: testMigrationId,
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.migration.status).toBe('completed');
    });
  });

  describe('Migration Rollback', () => {
    let rollbackMigrationId;

    beforeAll(async () => {
      // Create a new migration for rollback testing
      const v3Response = await request(app)
        .post('/api/v1/versioning/deploy-shadow')
        .send({
          contractId: testContractId,
          wasmHash: 'c'.repeat(64),
          deployedBy: 'GDEPLOYER',
        });

      const testVersion3 = v3Response.body.version.versionId;

      const migrationResponse = await request(app)
        .post('/api/v1/versioning/start-migration')
        .send({
          fromVersion: testVersion2,
          toVersion: testVersion3,
          initialPercentage: 5,
        });

      rollbackMigrationId = migrationResponse.body.migration.migrationId;
    });

    it('should rollback migration with reason', async () => {
      const response = await request(app)
        .post('/api/v1/versioning/rollback-migration')
        .send({
          migrationId: rollbackMigrationId,
          reason: 'High error rate detected in canary',
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.migration.status).toBe('rolled_back');
      expect(response.body.migration.reason).toBe('High error rate detected in canary');
    });

    it('should reject rollback without reason', async () => {
      const response = await request(app)
        .post('/api/v1/versioning/rollback-migration')
        .send({
          migrationId: rollbackMigrationId,
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('validation_failed');
    });
  });
});
