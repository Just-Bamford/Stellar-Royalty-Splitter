/**
 * Transaction Batching Engine with Compression
 * Issue #976 - Reduce transaction size by 80-90% through batching
 */

const logger = require('../logger');
const db = require('../database');
const zlib = require('zlib');
const { promisify } = require('util');

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);
const brotliCompress = promisify(zlib.brotliCompress);
const brotliDecompress = promisify(zlib.brotliDecompress);

/**
 * Compression algorithms
 */
const CompressionAlgorithm = {
  GZIP: 'gzip',
  BROTLI: 'brotli',
  NONE: 'none',
};

/**
 * Batch status
 */
const BatchStatus = {
  PENDING: 'pending',
  QUEUED: 'queued',
  PROCESSING: 'processing',
  COMPRESSED: 'compressed',
  SUBMITTED: 'submitted',
  CONFIRMED: 'confirmed',
  FAILED: 'failed',
};

class TransactionBatcherService {
  constructor() {
    this.maxBatchSize = 20; // Maximum transactions per batch
    this.batchWindow = 5000; // 5 seconds to collect transactions
    this.compressionThreshold = 500; // Compress if size > 500 bytes
    this.initializeDatabase();
  }

  /**
   * Initialize database tables for batching
   */
  initializeDatabase() {
    const createBatchesTable = `
      CREATE TABLE IF NOT EXISTS transaction_batches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        batch_id TEXT UNIQUE NOT NULL,
        contract_id TEXT NOT NULL,
        transaction_count INTEGER NOT NULL,
        original_size INTEGER NOT NULL,
        compressed_size INTEGER,
        compression_algorithm TEXT,
        compression_ratio REAL,
        xdr_data TEXT,
        status TEXT NOT NULL,
        gas_estimate INTEGER,
        fee_estimate INTEGER,
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        submitted_at INTEGER,
        confirmed_at INTEGER
      )
    `;

    const createBatchItemsTable = `
      CREATE TABLE IF NOT EXISTS batch_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        batch_id TEXT NOT NULL,
        item_index INTEGER NOT NULL,
        operation_type TEXT NOT NULL,
        token_address TEXT,
        recipient_count INTEGER,
        estimated_fee INTEGER,
        metadata TEXT,
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        FOREIGN KEY (batch_id) REFERENCES transaction_batches(batch_id)
      )
    `;

    const createCompressionMetricsTable = `
      CREATE TABLE IF NOT EXISTS compression_metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        batch_id TEXT NOT NULL,
        algorithm TEXT NOT NULL,
        original_size INTEGER NOT NULL,
        compressed_size INTEGER NOT NULL,
        compression_time_ms INTEGER NOT NULL,
        compression_ratio REAL NOT NULL,
        recorded_at INTEGER DEFAULT (strftime('%s', 'now'))
      )
    `;

    try {
      db.prepare(createBatchesTable).run();
      db.prepare(createBatchItemsTable).run();
      db.prepare(createCompressionMetricsTable).run();

      // Create indexes
      db.prepare('CREATE INDEX IF NOT EXISTS idx_batches_status ON transaction_batches(status, created_at)').run();
      db.prepare('CREATE INDEX IF NOT EXISTS idx_batches_contract ON transaction_batches(contract_id)').run();
      db.prepare('CREATE INDEX IF NOT EXISTS idx_batch_items_batch ON batch_items(batch_id)').run();

      logger.info('Transaction batcher database initialized');
    } catch (error) {
      logger.error('Failed to initialize batcher database', error);
      throw error;
    }
  }

  /**
   * Create a new batch
   */
  createBatch(contractId, transactions) {
    if (!Array.isArray(transactions) || transactions.length === 0) {
      throw new Error('Transactions array cannot be empty');
    }

    if (transactions.length > this.maxBatchSize) {
      throw new Error(`Batch size exceeds maximum of ${this.maxBatchSize}`);
    }

    const batchId = `batch-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const createdAt = Math.floor(Date.now() / 1000);

    // Calculate original size (estimate XDR size)
    const originalSize = this.estimateTransactionSize(transactions);

    // Insert batch record
    const batchStmt = db.prepare(`
      INSERT INTO transaction_batches (
        batch_id, contract_id, transaction_count, original_size, status
      ) VALUES (?, ?, ?, ?, ?)
    `);

    batchStmt.run(batchId, contractId, transactions.length, originalSize, BatchStatus.QUEUED);

    // Insert batch items
    const itemStmt = db.prepare(`
      INSERT INTO batch_items (
        batch_id, item_index, operation_type, token_address, recipient_count, estimated_fee, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    transactions.forEach((tx, index) => {
      itemStmt.run(
        batchId,
        index,
        tx.operationType || 'distribute',
        tx.tokenAddress || null,
        tx.recipientCount || 0,
        tx.estimatedFee || 0,
        JSON.stringify(tx.metadata || {})
      );
    });

    logger.info(`Created batch ${batchId} with ${transactions.length} transactions`);

    return {
      batchId,
      contractId,
      transactionCount: transactions.length,
      originalSize,
      status: BatchStatus.QUEUED,
    };
  }

  /**
   * Compress batch XDR data
   */
  async compressBatch(batchId, xdrData, algorithm = CompressionAlgorithm.BROTLI) {
    const batch = db.prepare('SELECT * FROM transaction_batches WHERE batch_id = ?')
      .get(batchId);

    if (!batch) {
      throw new Error(`Batch ${batchId} not found`);
    }

    const startTime = Date.now();
    const originalBuffer = Buffer.from(xdrData, 'base64');
    const originalSize = originalBuffer.length;

    let compressedBuffer;
    let actualAlgorithm = algorithm;

    // Only compress if above threshold
    if (originalSize < this.compressionThreshold) {
      compressedBuffer = originalBuffer;
      actualAlgorithm = CompressionAlgorithm.NONE;
    } else {
      try {
        if (algorithm === CompressionAlgorithm.BROTLI) {
          compressedBuffer = await brotliCompress(originalBuffer, {
            params: {
              [zlib.constants.BROTLI_PARAM_QUALITY]: 6, // Balance speed vs ratio
            },
          });
        } else if (algorithm === CompressionAlgorithm.GZIP) {
          compressedBuffer = await gzip(originalBuffer, {
            level: 6,
          });
        } else {
          compressedBuffer = originalBuffer;
          actualAlgorithm = CompressionAlgorithm.NONE;
        }
      } catch (error) {
        logger.warn(`Compression failed, using uncompressed data: ${error.message}`);
        compressedBuffer = originalBuffer;
        actualAlgorithm = CompressionAlgorithm.NONE;
      }
    }

    const compressedSize = compressedBuffer.length;
    const compressionTime = Date.now() - startTime;
    const compressionRatio = originalSize > 0 ? (compressedSize / originalSize) : 1;
    const savingsPercentage = ((1 - compressionRatio) * 100).toFixed(2);

    // Update batch record
    db.prepare(`
      UPDATE transaction_batches
      SET compressed_size = ?,
          compression_algorithm = ?,
          compression_ratio = ?,
          xdr_data = ?,
          status = ?
      WHERE batch_id = ?
    `).run(
      compressedSize,
      actualAlgorithm,
      compressionRatio,
      compressedBuffer.toString('base64'),
      BatchStatus.COMPRESSED,
      batchId
    );

    // Record compression metrics
    db.prepare(`
      INSERT INTO compression_metrics (
        batch_id, algorithm, original_size, compressed_size, compression_time_ms, compression_ratio
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(batchId, actualAlgorithm, originalSize, compressedSize, compressionTime, compressionRatio);

    logger.info(`Compressed batch ${batchId}: ${originalSize} -> ${compressedSize} bytes (${savingsPercentage}% savings) using ${actualAlgorithm}`);

    return {
      batchId,
      originalSize,
      compressedSize,
      compressionRatio,
      savingsPercentage: parseFloat(savingsPercentage),
      algorithm: actualAlgorithm,
      compressionTime,
    };
  }

  /**
   * Decompress batch XDR data
   */
  async decompressBatch(batchId) {
    const batch = db.prepare('SELECT * FROM transaction_batches WHERE batch_id = ?')
      .get(batchId);

    if (!batch) {
      throw new Error(`Batch ${batchId} not found`);
    }

    if (!batch.xdr_data) {
      throw new Error(`No XDR data found for batch ${batchId}`);
    }

    const compressedBuffer = Buffer.from(batch.xdr_data, 'base64');

    if (batch.compression_algorithm === CompressionAlgorithm.NONE) {
      return compressedBuffer.toString('base64');
    }

    let decompressedBuffer;

    try {
      if (batch.compression_algorithm === CompressionAlgorithm.BROTLI) {
        decompressedBuffer = await brotliDecompress(compressedBuffer);
      } else if (batch.compression_algorithm === CompressionAlgorithm.GZIP) {
        decompressedBuffer = await gunzip(compressedBuffer);
      } else {
        decompressedBuffer = compressedBuffer;
      }
    } catch (error) {
      logger.error(`Failed to decompress batch ${batchId}:`, error);
      throw new Error(`Decompression failed: ${error.message}`);
    }

    return decompressedBuffer.toString('base64');
  }

  /**
   * Mark batch as submitted
   */
  markSubmitted(batchId, gasEstimate, feeEstimate) {
    const submittedAt = Math.floor(Date.now() / 1000);

    db.prepare(`
      UPDATE transaction_batches
      SET status = ?,
          gas_estimate = ?,
          fee_estimate = ?,
          submitted_at = ?
      WHERE batch_id = ?
    `).run(BatchStatus.SUBMITTED, gasEstimate, feeEstimate, submittedAt, batchId);

    logger.info(`Batch ${batchId} submitted with gas: ${gasEstimate}, fee: ${feeEstimate}`);
  }

  /**
   * Mark batch as confirmed
   */
  markConfirmed(batchId) {
    const confirmedAt = Math.floor(Date.now() / 1000);

    db.prepare(`
      UPDATE transaction_batches
      SET status = ?, confirmed_at = ?
      WHERE batch_id = ?
    `).run(BatchStatus.CONFIRMED, confirmedAt, batchId);

    logger.info(`Batch ${batchId} confirmed`);
  }

  /**
   * Mark batch as failed
   */
  markFailed(batchId, reason) {
    db.prepare(`
      UPDATE transaction_batches
      SET status = ?
      WHERE batch_id = ?
    `).run(BatchStatus.FAILED, batchId);

    logger.error(`Batch ${batchId} failed: ${reason}`);
  }

  /**
   * Get batch details
   */
  getBatch(batchId) {
    const batch = db.prepare('SELECT * FROM transaction_batches WHERE batch_id = ?')
      .get(batchId);

    if (!batch) {
      return null;
    }

    const items = db.prepare('SELECT * FROM batch_items WHERE batch_id = ? ORDER BY item_index')
      .all(batchId);

    return {
      ...batch,
      items: items.map(item => ({
        ...item,
        metadata: JSON.parse(item.metadata || '{}'),
      })),
    };
  }

  /**
   * Get batch statistics
   */
  getBatchStatistics(contractId = null, since = null) {
    let query = 'SELECT * FROM transaction_batches WHERE 1=1';
    const params = [];

    if (contractId) {
      query += ' AND contract_id = ?';
      params.push(contractId);
    }

    if (since) {
      query += ' AND created_at >= ?';
      params.push(since);
    }

    const batches = db.prepare(query).all(...params);

    const stats = {
      totalBatches: batches.length,
      totalTransactions: batches.reduce((sum, b) => sum + b.transaction_count, 0),
      totalOriginalSize: batches.reduce((sum, b) => sum + b.original_size, 0),
      totalCompressedSize: batches.reduce((sum, b) => sum + (b.compressed_size || b.original_size), 0),
      averageCompressionRatio: 0,
      averageTransactionsPerBatch: 0,
      statusBreakdown: {},
    };

    if (batches.length > 0) {
      stats.averageCompressionRatio = batches
        .filter(b => b.compression_ratio)
        .reduce((sum, b) => sum + b.compression_ratio, 0) / batches.filter(b => b.compression_ratio).length;

      stats.averageTransactionsPerBatch = stats.totalTransactions / stats.totalBatches;

      stats.overallSavingsPercentage = stats.totalOriginalSize > 0
        ? ((1 - (stats.totalCompressedSize / stats.totalOriginalSize)) * 100).toFixed(2)
        : 0;

      // Status breakdown
      batches.forEach(batch => {
        stats.statusBreakdown[batch.status] = (stats.statusBreakdown[batch.status] || 0) + 1;
      });
    }

    return stats;
  }

  /**
   * Get compression metrics
   */
  getCompressionMetrics(batchId = null, algorithm = null) {
    let query = 'SELECT * FROM compression_metrics WHERE 1=1';
    const params = [];

    if (batchId) {
      query += ' AND batch_id = ?';
      params.push(batchId);
    }

    if (algorithm) {
      query += ' AND algorithm = ?';
      params.push(algorithm);
    }

    query += ' ORDER BY recorded_at DESC LIMIT 1000';

    return db.prepare(query).all(...params);
  }

  /**
   * Estimate transaction size (simplified)
   */
  estimateTransactionSize(transactions) {
    // Rough estimate: 500 bytes base + 200 bytes per transaction
    return 500 + (transactions.length * 200);
  }

  /**
   * Get pending batches
   */
  getPendingBatches(limit = 100) {
    return db.prepare(`
      SELECT * FROM transaction_batches
      WHERE status IN (?, ?)
      ORDER BY created_at ASC
      LIMIT ?
    `).all(BatchStatus.PENDING, BatchStatus.QUEUED, limit);
  }

  /**
   * Compare batch vs individual transaction costs
   */
  compareCosts(transactionCount, gasPerTransaction = 100000) {
    const batchGas = gasPerTransaction * transactionCount * 0.3; // 70% savings
    const individualGas = gasPerTransaction * transactionCount;

    const savings = individualGas - batchGas;
    const savingsPercentage = ((savings / individualGas) * 100).toFixed(2);

    return {
      transactionCount,
      batchGas: Math.floor(batchGas),
      individualGas,
      savings: Math.floor(savings),
      savingsPercentage: parseFloat(savingsPercentage),
      recommendBatch: transactionCount > 1,
    };
  }
}

module.exports = new TransactionBatcherService();
