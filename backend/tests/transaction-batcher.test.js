/**
 * Tests for Transaction Batching Engine
 * Issue #976
 */

const request = require('supertest');
const express = require('express');
const batchRoutes = require('../src/routes/transaction-batch');
const batcherService = require('../src/services/transaction-batcher');

const app = express();
app.use(express.json());
app.use('/api/v1', batchRoutes);

describe('Transaction Batching Engine', () => {
  let testBatchId;
  const testContractId = 'CBATCHTEST123';
  const testTokens = [
    'CTOKEN1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    'CTOKEN2BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    'CTOKEN3CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
  ];

  describe('Batch Creation', () => {
    it('should create a batch distribution', async () => {
      const response = await request(app)
        .post('/api/v1/batch-distribute')
        .send({
          contractId: testContractId,
          tokens: testTokens,
          compress: true,
          algorithm: 'brotli',
        });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('batchId');
      expect(response.body).toHaveProperty('xdr');
      expect(response.body.tokensIncluded).toBe(3);
      expect(response.body.compression).toBeDefined();
      expect(response.body.compression.algorithm).toBe('brotli');

      testBatchId = response.body.batchId;
    });

    it('should reject empty tokens array', async () => {
      const response = await request(app)
        .post('/api/v1/batch-distribute')
        .send({
          contractId: testContractId,
          tokens: [],
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('validation_failed');
    });

    it('should reject batch with more than 20 tokens', async () => {
      const tooManyTokens = Array.from({ length: 25 }, (_, i) => `CTOKEN${i}`);

      const response = await request(app)
        .post('/api/v1/batch-distribute')
        .send({
          contractId: testContractId,
          tokens: tooManyTokens,
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('validation_failed');
      expect(response.body.message).toContain('Maximum 20 tokens');
    });

    it('should create uncompressed batch when compress=false', async () => {
      const response = await request(app)
        .post('/api/v1/batch-distribute')
        .send({
          contractId: testContractId,
          tokens: testTokens,
          compress: false,
        });

      expect(response.status).toBe(200);
      expect(response.body.compression.algorithm).toBe('none');
    });
  });

  describe('Compression', () => {
    it('should compress using gzip algorithm', async () => {
      const response = await request(app)
        .post('/api/v1/batch-distribute')
        .send({
          contractId: testContractId,
          tokens: testTokens,
          compress: true,
          algorithm: 'gzip',
        });

      expect(response.status).toBe(200);
      expect(response.body.compression.algorithm).toBe('gzip');
      expect(response.body.compression.savingsPercentage).toBeGreaterThan(0);
    });

    it('should achieve significant compression ratio', async () => {
      const manyTokens = Array.from({ length: 10 }, (_, i) => `CTOKEN${i}${'A'.repeat(50)}`);

      const response = await request(app)
        .post('/api/v1/batch-distribute')
        .send({
          contractId: testContractId,
          tokens: manyTokens,
          compress: true,
          algorithm: 'brotli',
        });

      expect(response.status).toBe(200);
      expect(response.body.compression.savingsPercentage).toBeGreaterThanOrEqual(30);
    });

    it('should decompress batch correctly', async () => {
      const decompressResponse = await request(app)
        .get(`/api/v1/batch/${testBatchId}/decompress`);

      expect(decompressResponse.status).toBe(200);
      expect(decompressResponse.body.success).toBe(true);
      expect(decompressResponse.body.xdr).toBeDefined();
    });
  });

  describe('Cost Estimation', () => {
    it('should estimate gas savings for batch', async () => {
      const response = await request(app)
        .post('/api/v1/batch-distribute/estimate')
        .send({
          tokens: testTokens,
        });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('batchFee');
      expect(response.body).toHaveProperty('individualFeesTotal');
      expect(response.body).toHaveProperty('savings');
      expect(response.body).toHaveProperty('savingsPercentage');
      expect(response.body.batchFee).toBeLessThan(response.body.individualFeesTotal);
      expect(response.body.savingsPercentage).toBeGreaterThan(50);
    });

    it('should show higher savings with more transactions', async () => {
      const smallBatch = await request(app)
        .post('/api/v1/batch-distribute/estimate')
        .send({ tokens: testTokens.slice(0, 2) });

      const largeBatch = await request(app)
        .post('/api/v1/batch-distribute/estimate')
        .send({ tokens: Array.from({ length: 15 }, (_, i) => `CTOKEN${i}`) });

      expect(largeBatch.body.savings).toBeGreaterThan(smallBatch.body.savings);
    });

    it('should recommend batch for multiple transactions', async () => {
      const response = await request(app)
        .post('/api/v1/batch-distribute/estimate')
        .send({
          tokens: testTokens,
        });

      expect(response.body.recommendBatch).toBe(true);
    });
  });

  describe('Batch Retrieval', () => {
    it('should retrieve batch details', async () => {
      const response = await request(app)
        .get(`/api/v1/batch/${testBatchId}`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.batch).toHaveProperty('batch_id');
      expect(response.body.batch).toHaveProperty('items');
      expect(response.body.batch.items).toBeInstanceOf(Array);
    });

    it('should return 404 for non-existent batch', async () => {
      const response = await request(app)
        .get('/api/v1/batch/nonexistent-batch-id');

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('batch_not_found');
    });
  });

  describe('Batch Status Updates', () => {
    let statusBatchId;

    beforeAll(async () => {
      const createResponse = await request(app)
        .post('/api/v1/batch-distribute')
        .send({
          contractId: testContractId,
          tokens: testTokens,
        });

      statusBatchId = createResponse.body.batchId;
    });

    it('should mark batch as submitted', async () => {
      const response = await request(app)
        .post(`/api/v1/batch/${statusBatchId}/submit`)
        .send({
          gasEstimate: 500000,
          feeEstimate: 150000,
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.status).toBe('submitted');
    });

    it('should mark batch as confirmed', async () => {
      const response = await request(app)
        .post(`/api/v1/batch/${statusBatchId}/confirm`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.status).toBe('confirmed');
    });

    it('should mark batch as failed with reason', async () => {
      // Create a new batch for failure test
      const createResponse = await request(app)
        .post('/api/v1/batch-distribute')
        .send({
          contractId: testContractId,
          tokens: testTokens,
        });

      const failBatchId = createResponse.body.batchId;

      const response = await request(app)
        .post(`/api/v1/batch/${failBatchId}/fail`)
        .send({
          reason: 'Insufficient funds',
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.status).toBe('failed');
      expect(response.body.reason).toBe('Insufficient funds');
    });

    it('should reject status update without required fields', async () => {
      const response = await request(app)
        .post(`/api/v1/batch/${statusBatchId}/submit`)
        .send({
          gasEstimate: 500000,
          // Missing feeEstimate
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('validation_failed');
    });
  });

  describe('Statistics and Metrics', () => {
    it('should retrieve batch statistics', async () => {
      const response = await request(app)
        .get('/api/v1/statistics');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.statistics).toHaveProperty('totalBatches');
      expect(response.body.statistics).toHaveProperty('totalTransactions');
      expect(response.body.statistics).toHaveProperty('averageCompressionRatio');
      expect(response.body.statistics).toHaveProperty('overallSavingsPercentage');
    });

    it('should retrieve statistics for specific contract', async () => {
      const response = await request(app)
        .get('/api/v1/statistics')
        .query({ contractId: testContractId });

      expect(response.status).toBe(200);
      expect(response.body.statistics.totalBatches).toBeGreaterThan(0);
    });

    it('should retrieve compression metrics', async () => {
      const response = await request(app)
        .get('/api/v1/compression-metrics');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.metrics).toBeInstanceOf(Array);
    });

    it('should retrieve compression metrics for specific algorithm', async () => {
      const response = await request(app)
        .get('/api/v1/compression-metrics')
        .query({ algorithm: 'brotli' });

      expect(response.status).toBe(200);
      expect(response.body.metrics.every(m => m.algorithm === 'brotli')).toBe(true);
    });
  });

  describe('Pending Batches', () => {
    it('should retrieve pending batches', async () => {
      const response = await request(app)
        .get('/api/v1/pending');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.batches).toBeInstanceOf(Array);
    });

    it('should respect limit parameter', async () => {
      const response = await request(app)
        .get('/api/v1/pending')
        .query({ limit: 5 });

      expect(response.status).toBe(200);
      expect(response.body.batches.length).toBeLessThanOrEqual(5);
    });
  });

  describe('Performance', () => {
    it('should handle large batch creation efficiently', async () => {
      const largeTokenArray = Array.from({ length: 20 }, (_, i) => `CTOKEN${i}${'X'.repeat(50)}`);

      const startTime = Date.now();

      const response = await request(app)
        .post('/api/v1/batch-distribute')
        .send({
          contractId: testContractId,
          tokens: largeTokenArray,
          compress: true,
          algorithm: 'brotli',
        });

      const duration = Date.now() - startTime;

      expect(response.status).toBe(200);
      expect(duration).toBeLessThan(5000); // Should complete in under 5 seconds
    });

    it('should compress large batches in reasonable time', async () => {
      const response = await request(app)
        .post('/api/v1/batch-distribute')
        .send({
          contractId: testContractId,
          tokens: Array.from({ length: 20 }, (_, i) => `CTOKEN${i}`),
          compress: true,
        });

      expect(response.status).toBe(200);
      expect(response.body.compression).toBeDefined();
      // Compression should happen quickly
    });
  });
});
