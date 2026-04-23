import express from 'express';
import {
  getTransactionHistory,
  getTransactionCount,
  getTransactionDetails,
  getAuditLog,
  addAuditLog,
  updateTransactionStatus
} from '../database.js';
import { validateContractId, parsePagination } from '../validation.js';

const router = express.Router();

/**
 * GET /api/history/:contractId
 * Get transaction history for a contract
 * Query params: limit (default 50), offset (default 0)
 */
router.get('/history/:contractId', (req, res) => {
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
    console.error('Error fetching transaction history:', error);
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
    console.error('Error fetching transaction details:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/transaction/confirm/:txHash
 * Confirm a transaction (update status based on chain verification)
 */
router.post('/transaction/confirm/:txHash', (req, res) => {
  try {
    const { txHash } = req.params;
    const { status, blockTime, errorMessage } = req.body;

    if (!['confirmed', 'failed', 'pending'].includes(status)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid status'
      });
    }

    updateTransactionStatus(txHash, status, blockTime, errorMessage);

    res.json({
      success: true,
      message: `Transaction ${txHash.substring(0, 8)}... marked as ${status}`
    });
  } catch (error) {
    console.error('Error updating transaction status:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/audit/:contractId
 * Get audit log for a contract
 * Query params: limit (default 100), offset (default 0)
 */
router.get('/audit/:contractId', (req, res) => {
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
    console.error('Error fetching audit log:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/audit/:contractId
 * Add audit log entry
 */
router.post('/audit/:contractId', (req, res) => {
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
    console.error('Error creating audit log entry:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

export default router;
