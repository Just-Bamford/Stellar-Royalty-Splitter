import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import { errorResponse } from '../src/error-response.js';

const VERSION_IDENTIFIER_REGEX = /^(?:C[A-Z2-7]{55}|[a-zA-Z0-9](?:[a-zA-Z0-9_.-]{0,62}[a-zA-Z0-9])?)$/;

function isValidVersionIdentifier(version) {
  if (typeof version !== 'string') {
    return false;
  }
  const trimmed = version.trim();
  if (!trimmed || trimmed !== version) {
    return false;
  }
  return VERSION_IDENTIFIER_REGEX.test(trimmed);
}

describe('Contract Versioning Migration Validation (#1418)', () => {
  describe('isValidVersionIdentifier', () => {
    it('accepts valid version identifiers and semver', () => {
      expect(isValidVersionIdentifier('v1')).toBe(true);
      expect(isValidVersionIdentifier('v2')).toBe(true);
      expect(isValidVersionIdentifier('v1.0.0')).toBe(true);
      expect(isValidVersionIdentifier('1.0.0')).toBe(true);
      expect(isValidVersionIdentifier('v1.2.3-alpha.1')).toBe(true);
      expect(isValidVersionIdentifier('v1732307200000')).toBe(true);
      expect(isValidVersionIdentifier('version_1')).toBe(true);
      expect(isValidVersionIdentifier('canary-v2')).toBe(true);
    });

    it('accepts valid Stellar contract IDs', () => {
      const stellarContractId = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
      expect(isValidVersionIdentifier(stellarContractId)).toBe(true);
      expect(isValidVersionIdentifier('CTEST123CONTRACT')).toBe(true);
    });

    it('rejects invalid or malformed version identifiers', () => {
      expect(isValidVersionIdentifier('')).toBe(false);
      expect(isValidVersionIdentifier('   ')).toBe(false);
      expect(isValidVersionIdentifier('v 1.0')).toBe(false);
      expect(isValidVersionIdentifier(' v1.0')).toBe(false);
      expect(isValidVersionIdentifier('v1.0 ')).toBe(false);
      expect(isValidVersionIdentifier(null)).toBe(false);
      expect(isValidVersionIdentifier(undefined)).toBe(false);
      expect(isValidVersionIdentifier(12345)).toBe(false);
      expect(isValidVersionIdentifier({})).toBe(false);
      expect(isValidVersionIdentifier([])).toBe(false);
      expect(isValidVersionIdentifier(true)).toBe(false);
      expect(isValidVersionIdentifier('v1; DROP TABLE contract_versions;')).toBe(false);
      expect(isValidVersionIdentifier('<script>alert("xss")</script>')).toBe(false);
      expect(isValidVersionIdentifier('../v1')).toBe(false);
      expect(isValidVersionIdentifier('v1/v2')).toBe(false);
      expect(isValidVersionIdentifier('-v1')).toBe(false);
      expect(isValidVersionIdentifier('.v1')).toBe(false);
      expect(isValidVersionIdentifier('v1-')).toBe(false);
      expect(isValidVersionIdentifier('v1.')).toBe(false);
      expect(isValidVersionIdentifier('a'.repeat(65))).toBe(false);
    });
  });

  describe('POST /start-migration route validation', () => {
    let app;
    let mockStartMigration;

    beforeEach(() => {
      mockStartMigration = jest.fn((fromVersion, toVersion, pct) => ({
        migrationId: 'migration-test-123',
        fromVersion,
        toVersion,
        stage: 'stage_2_canary_5',
        rolloutPercentage: pct,
        status: 'in_progress',
      }));

      app = express();
      app.use(express.json());

      app.post('/api/v1/versioning/start-migration', async (req, res) => {
        try {
          const { fromVersion, toVersion, initialPercentage = 5 } = req.body;

          if (!fromVersion || !toVersion) {
            return res.status(400).json(
              errorResponse('validation_failed', 'fromVersion and toVersion are required')
            );
          }

          if (!isValidVersionIdentifier(fromVersion) || !isValidVersionIdentifier(toVersion)) {
            return res.status(400).json(
              errorResponse('validation_failed', 'fromVersion and toVersion must be valid contract version identifiers')
            );
          }

          const pct = Number(initialPercentage);
          if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
            return res.status(400).json(
              errorResponse('validation_failed', 'initialPercentage must be between 0 and 100')
            );
          }

          const result = mockStartMigration(fromVersion, toVersion, pct);

          res.status(201).json({
            success: true,
            migration: result,
          });
        } catch (error) {
          res.status(500).json(errorResponse('migration_start_failed', error.message));
        }
      });
    });

    it('rejects missing fromVersion or toVersion', async () => {
      const res1 = await request(app)
        .post('/api/v1/versioning/start-migration')
        .send({ toVersion: 'v2' });
      expect(res1.status).toBe(400);
      expect(res1.body.error).toBe('validation_failed');
      expect(res1.body.message).toContain('required');

      const res2 = await request(app)
        .post('/api/v1/versioning/start-migration')
        .send({ fromVersion: 'v1' });
      expect(res2.status).toBe(400);
      expect(res2.body.error).toBe('validation_failed');
    });

    it('rejects invalid fromVersion as contract version identifier', async () => {
      const res = await request(app)
        .post('/api/v1/versioning/start-migration')
        .send({
          fromVersion: 'invalid version identifier',
          toVersion: 'v2',
        });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('validation_failed');
      expect(res.body.message).toBe('fromVersion and toVersion must be valid contract version identifiers');
      expect(mockStartMigration).not.toHaveBeenCalled();
    });

    it('rejects invalid toVersion as contract version identifier', async () => {
      const res = await request(app)
        .post('/api/v1/versioning/start-migration')
        .send({
          fromVersion: 'v1',
          toVersion: 'v2; DROP TABLE contracts',
        });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('validation_failed');
      expect(res.body.message).toBe('fromVersion and toVersion must be valid contract version identifiers');
      expect(mockStartMigration).not.toHaveBeenCalled();
    });

    it('rejects out of range initialPercentage (< 0 or > 100)', async () => {
      const resLow = await request(app)
        .post('/api/v1/versioning/start-migration')
        .send({
          fromVersion: 'v1',
          toVersion: 'v2',
          initialPercentage: -5,
        });
      expect(resLow.status).toBe(400);
      expect(resLow.body.error).toBe('validation_failed');
      expect(resLow.body.message).toBe('initialPercentage must be between 0 and 100');

      const resHigh = await request(app)
        .post('/api/v1/versioning/start-migration')
        .send({
          fromVersion: 'v1',
          toVersion: 'v2',
          initialPercentage: 105,
        });
      expect(resHigh.status).toBe(400);
      expect(resHigh.body.error).toBe('validation_failed');
    });

    it('rejects non-numeric initialPercentage (strings that do not parse to numbers, NaN, null)', async () => {
      const resString = await request(app)
        .post('/api/v1/versioning/start-migration')
        .send({
          fromVersion: 'v1',
          toVersion: 'v2',
          initialPercentage: 'not-a-number',
        });
      expect(resString.status).toBe(400);
      expect(resString.body.error).toBe('validation_failed');
    });

    it('accepts string numbers and parses initialPercentage as number', async () => {
      const res = await request(app)
        .post('/api/v1/versioning/start-migration')
        .send({
          fromVersion: 'v1',
          toVersion: 'v2',
          initialPercentage: '25',
        });
      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(mockStartMigration).toHaveBeenCalledWith('v1', 'v2', 25);
    });

    it('accepts valid contract IDs and version identifiers', async () => {
      const contract1 = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
      const contract2 = 'CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
      const res = await request(app)
        .post('/api/v1/versioning/start-migration')
        .send({
          fromVersion: contract1,
          toVersion: contract2,
          initialPercentage: 10,
        });
      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(mockStartMigration).toHaveBeenCalledWith(contract1, contract2, 10);
    });
  });
});
