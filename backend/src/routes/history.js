import express from 'express';
import {
  getTransactionHistory,
  getTransactionCount,
  getTransactionDetails,
  getAuditLog,
  addAuditLog,
  updateTransactionStatus
} from '../database.js';
import { validateContractId, validateContractIdMiddleware, parsePagination } from '../validation.js';
import { server } from '../stellar.js';
import logger from '../logger.js';

const router = express.Router();

/**
 * GET /api/history/:contractId
 * Get transaction history for a contract
 * Query params: limit (default 50), offset (default 0)
 */
router.get('/history/:contractId', validateContractIdMiddleware, (req, res) => {
  try {
    const { contractId } = req.params;
    if (!validateContractId(contractId, res)) return;

    const pagination = parsePagination(req.query, res, 50, 100);
    if (!pagination) return;
    const { limit, offset } = pagination;

    const history = getTransactionHistory(contractId, limit, offset);
    const total = getTransactionCount(contractId);

    res.json({
      success: true,
      data: history,
      pagination: { limit, offset, total }
    });
  } catch (error) {
    logger.error('Error fetching transaction history:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/transaction/:txHash
 * Get details of a specific transaction including all payouts
 */
router.get('/transaction/:txHash', (req, res) => {
  try {
    const { txHash } = req.params;

    const transaction = getTransactionDetails(txHash);

    if (!transaction) {
      return res.status(404).json({
        success: false,
        error: 'Transaction not found'
      });
    }

    res.json({
      success: true,
      data: transaction
    });
  } catch (error) {
    logger.error('Error fetching transaction details:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/transaction/confirm/:txHash
 * Verify on-chain status via Soroban RPC before updating the DB.
 * Returns 409 if the requested status contradicts the on-chain result.
 */
router.post('/transaction/confirm/:txHash', async (req, res) => {
  try {
    const { txHash } = req.params;
    const { blockTime, errorMessage } = req.body;

    // Validate transaction hash format (64 hex characters)
    if (!/^[0-9a-fA-F]{64}$/.test(txHash)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid transaction hash format. Expected 64 hexadecimal characters.'
      });
    }

    // Return 404 if transaction does not exist
    const existing = getTransactionDetails(txHash);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Transaction not found' });
    }

    // Prevent overwriting already-settled transactions
    if (existing.status !== 'pending') {
      return res.status(409).json({
        success: false,
        error: `Transaction already ${existing.status}`
      });
    }

    // Verify on-chain status
    let onChainResult;
    try {
      onChainResult = await server.getTransaction(txHash);
    } catch {
      return res.status(502).json({ success: false, error: 'Failed to reach Stellar RPC' });
    }

    // Map Stellar RPC status to our DB status
    const STATUS_MAP = { SUCCESS: 'confirmed', FAILED: 'failed' };
    const resolvedStatus = STATUS_MAP[onChainResult.status];

    if (!resolvedStatus) {
      // NOT_FOUND or still pending on-chain
      return res.status(409).json({
        success: false,
        error: `Transaction not yet finalized on-chain (status: ${onChainResult.status})`
      });
    }

    updateTransactionStatus(txHash, resolvedStatus, blockTime ?? null, errorMessage ?? null);

    res.json({
      success: true,
      message: `Transaction ${txHash.substring(0, 8)}... marked as ${resolvedStatus}`
    });
  } catch (error) {
    logger.error('Error updating transaction status:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/audit/:contractId
 * Get audit log for a contract
 * Query params: limit (default 100), offset (default 0)
 */
router.get('/audit/:contractId', validateContractIdMiddleware, (req, res) => {
  try {
    const { contractId } = req.params;
    if (!validateContractId(contractId, res)) return;

    const pagination = parsePagination(req.query, res, 100, 200);
    if (!pagination) return;
    const { limit, offset } = pagination;

    const auditLog = getAuditLog(contractId, limit, offset);

    res.json({
      success: true,
      data: auditLog,
      pagination: { limit, offset }
    });
  } catch (error) {
    logger.error('Error fetching audit log:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/audit/:contractId
 * Add audit log entry
 */
router.post('/audit/:contractId', validateContractIdMiddleware, (req, res) => {
  try {
    const { contractId } = req.params;
    const { action, user, details } = req.body;

    if (!action) {
      return res.status(400).json({
        success: false,
        error: 'Action is required'
      });
    }

    addAuditLog(contractId, action, user || 'unknown', details || {});

    res.json({
      success: true,
      message: 'Audit log entry created'
    });
  } catch (error) {
    logger.error('Error creating audit log entry:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

export default router;
