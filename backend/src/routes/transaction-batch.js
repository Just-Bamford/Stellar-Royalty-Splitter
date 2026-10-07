/**
 * API Routes for Transaction Batching
 * Issue #976
 */

const express = require('express');
const router = express.Router();
const batcherService = require('../services/transaction-batcher');
const { errorResponse } = require('../error-response');
const logger = require('../logger');

/**
 * POST /api/v1/batch-distribute
 * Create and submit a batch distribution
 */
router.post('/batch-distribute', async (req, res) => {
  try {
    const { contractId, tokens, compress = true, algorithm = 'brotli' } = req.body;

    if (!contractId || !Array.isArray(tokens) || tokens.length === 0) {
      return res.status(400).json(
        errorResponse('validation_failed', 'contractId and tokens array are required')
      );
    }

    if (tokens.length > 20) {
      return res.status(400).json(
        errorResponse('validation_failed', 'Maximum 20 tokens per batch')
      );
    }

    // Transform tokens into transactions
    const transactions = tokens.map((token, index) => ({
      operationType: 'distribute',
      tokenAddress: token,
      recipientCount: 3, // Mock value - would come from contract state
      estimatedFee: 50000,
      metadata: { index, token },
    }));

    // Create batch
    const batch = batcherService.createBatch(contractId, transactions);

    // Mock XDR generation (in real implementation, this would call Stellar SDK)
    const mockXdr = Buffer.from(
      `BATCH_XDR_${batch.batchId}_${tokens.join('_')}`
    ).toString('base64');

    // Compress if requested
    let compressionResult = null;
    if (compress) {
      compressionResult = await batcherService.compressBatch(
        batch.batchId,
        mockXdr,
        algorithm
      );
    } else {
      // Store uncompressed
      await batcherService.compressBatch(batch.batchId, mockXdr, 'none');
    }

    // Calculate estimates
    const gasEstimate = tokens.length * 150000;
    const feeEstimate = tokens.length * 50000;

    const response = {
      xdr: mockXdr,
      transactionId: batch.batchId,
      batchId: batch.batchId,
      totalFee: feeEstimate,
      gasEstimate,
      tokensIncluded: tokens.length,
      breakdown: tokens.map((token, index) => ({
        token,
        recipients: 3,
        estimatedFee: 50000,
      })),
    };

    if (compressionResult) {
      response.compression = {
        algorithm: compressionResult.algorithm,
        originalSize: compressionResult.originalSize,
        compressedSize: compressionResult.compressedSize,
        savingsPercentage: compressionResult.savingsPercentage,
      };
    }

    logger.info(`Batch distribution created: ${batch.batchId}`);

    res.json(response);
  } catch (error) {
    logger.error('Failed to create batch distribution', error);
    res.status(500).json(errorResponse('batch_creation_failed', error.message));
  }
});

/**
 * GET /api/v1/batch-distribute/estimate
 * Estimate gas costs for batch vs individual
 */
router.post('/batch-distribute/estimate', async (req, res) => {
  try {
    const { tokens } = req.body;

    if (!Array.isArray(tokens) || tokens.length === 0) {
      return res.status(400).json(
        errorResponse('validation_failed', 'tokens array is required')
      );
    }

    const comparison = batcherService.compareCosts(tokens.length);

    res.json({
      tokenCount: tokens.length,
      batchFee: comparison.batchGas,
      individualFeesTotal: comparison.individualGas,
      savings: comparison.savings,
      savingsPercentage: comparison.savingsPercentage,
      recommendBatch: comparison.recommendBatch,
    });
  } catch (error) {
    logger.error('Failed to estimate batch costs', error);
    res.status(500).json(errorResponse('estimation_failed', error.message));
  }
});

/**
 * GET /api/v1/batch/:batchId
 * Get batch details
 */
router.get('/batch/:batchId', (req, res) => {
  try {
    const { batchId } = req.params;

    const batch = batcherService.getBatch(batchId);

    if (!batch) {
      return res.status(404).json(
        errorResponse('batch_not_found', `Batch ${batchId} not found`)
      );
    }

    res.json({
      success: true,
      batch,
    });
  } catch (error) {
    logger.error('Failed to get batch', error);
    res.status(500).json(errorResponse('batch_retrieval_failed', error.message));
  }
});

/**
 * GET /api/v1/batch/:batchId/decompress
 * Decompress batch XDR
 */
router.get('/batch/:batchId/decompress', async (req, res) => {
  try {
    const { batchId } = req.params;

    const decompressedXdr = await batcherService.decompressBatch(batchId);

    res.json({
      success: true,
      batchId,
      xdr: decompressedXdr,
    });
  } catch (error) {
    logger.error('Failed to decompress batch', error);
    res.status(500).json(errorResponse('decompression_failed', error.message));
  }
});

/**
 * POST /api/v1/batch/:batchId/submit
 * Mark batch as submitted
 */
router.post('/batch/:batchId/submit', (req, res) => {
  try {
    const { batchId } = req.params;
    const { gasEstimate, feeEstimate } = req.body;

    if (!gasEstimate || !feeEstimate) {
      return res.status(400).json(
        errorResponse('validation_failed', 'gasEstimate and feeEstimate are required')
      );
    }

    batcherService.markSubmitted(batchId, gasEstimate, feeEstimate);

    res.json({
      success: true,
      batchId,
      status: 'submitted',
    });
  } catch (error) {
    logger.error('Failed to mark batch as submitted', error);
    res.status(500).json(errorResponse('submission_failed', error.message));
  }
});

/**
 * POST /api/v1/batch/:batchId/confirm
 * Mark batch as confirmed
 */
router.post('/batch/:batchId/confirm', (req, res) => {
  try {
    const { batchId } = req.params;

    batcherService.markConfirmed(batchId);

    res.json({
      success: true,
      batchId,
      status: 'confirmed',
    });
  } catch (error) {
    logger.error('Failed to mark batch as confirmed', error);
    res.status(500).json(errorResponse('confirmation_failed', error.message));
  }
});

/**
 * POST /api/v1/batch/:batchId/fail
 * Mark batch as failed
 */
router.post('/batch/:batchId/fail', (req, res) => {
  try {
    const { batchId } = req.params;
    const { reason } = req.body;

    if (!reason) {
      return res.status(400).json(
        errorResponse('validation_failed', 'reason is required')
      );
    }

    batcherService.markFailed(batchId, reason);

    res.json({
      success: true,
      batchId,
      status: 'failed',
      reason,
    });
  } catch (error) {
    logger.error('Failed to mark batch as failed', error);
    res.status(500).json(errorResponse('failure_marking_failed', error.message));
  }
});

/**
 * GET /api/v1/batch/statistics
 * Get batch statistics
 */
router.get('/statistics', (req, res) => {
  try {
    const { contractId, since } = req.query;

    const stats = batcherService.getBatchStatistics(
      contractId || null,
      since ? parseInt(since, 10) : null
    );

    res.json({
      success: true,
      statistics: stats,
    });
  } catch (error) {
    logger.error('Failed to get batch statistics', error);
    res.status(500).json(errorResponse('statistics_retrieval_failed', error.message));
  }
});

/**
 * GET /api/v1/batch/compression-metrics
 * Get compression metrics
 */
router.get('/compression-metrics', (req, res) => {
  try {
    const { batchId, algorithm } = req.query;

    const metrics = batcherService.getCompressionMetrics(
      batchId || null,
      algorithm || null
    );

    res.json({
      success: true,
      metrics,
      count: metrics.length,
    });
  } catch (error) {
    logger.error('Failed to get compression metrics', error);
    res.status(500).json(errorResponse('metrics_retrieval_failed', error.message));
  }
});

/**
 * GET /api/v1/batch/pending
 * Get pending batches
 */
router.get('/pending', (req, res) => {
  try {
    const { limit = 100 } = req.query;

    const batches = batcherService.getPendingBatches(parseInt(limit, 10));

    res.json({
      success: true,
      batches,
      count: batches.length,
    });
  } catch (error) {
    logger.error('Failed to get pending batches', error);
    res.status(500).json(errorResponse('pending_retrieval_failed', error.message));
  }
});

module.exports = router;
