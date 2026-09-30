import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import { countWrite } from "./index.js";
import logger from "../logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DATABASE_PATH ?? path.join(__dirname, "..", "..", "audit.db");
const db = new Database(dbPath);

/**
 * #960: Dynamic royalty oracle with machine learning predictions
 */

/**
 * Store a royalty prediction
 */
export function storePrediction({
  contractId,
  predictedAmount,
  confidence,
  factors,
  modelVersion,
  predictionHorizon,
}) {
  const stmt = db.prepare(`
    INSERT INTO royalty_predictions 
    (contractId, predictedAmount, confidence, factors, modelVersion, predictionHorizon, predictedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const now = new Date().toISOString();
  const result = stmt.run(
    contractId,
    predictedAmount,
    confidence,
    JSON.stringify(factors),
    modelVersion,
    predictionHorizon,
    now
  );

  countWrite();
  logger.info("Royalty prediction stored", { contractId, predictedAmount, confidence, modelVersion });

  return result.lastInsertRowid;
}

/**
 * Get latest prediction for a contract
 */
export function getLatestPrediction(contractId, horizon = "7d") {
  return db
    .prepare(
      `SELECT * FROM royalty_predictions 
       WHERE contractId = ? AND predictionHorizon = ?
       ORDER BY predictedAt DESC 
       LIMIT 1`
    )
    .get(contractId, horizon);
}

/**
 * Get prediction history for a contract
 */
export function getPredictionHistory(contractId, limit = 50, offset = 0) {
  return db
    .prepare(
      `SELECT * FROM royalty_predictions 
       WHERE contractId = ?
       ORDER BY predictedAt DESC
       LIMIT ? OFFSET ?`
    )
    .all(contractId, limit, offset);
}

/**
 * Store ML model metadata
 */
export function storeModelMetadata({
  version,
  accuracy,
  precision,
  recall,
  f1Score,
  trainingDataSize,
  featuresUsed,
  hyperparameters,
  trainedBy,
}) {
  const stmt = db.prepare(`
    INSERT INTO ml_model_metadata 
    (version, accuracy, precision, recall, f1Score, trainingDataSize, featuresUsed, hyperparameters, trainedBy, trainedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const now = new Date().toISOString();
  const result = stmt.run(
    version,
    accuracy,
    precision,
    recall,
    f1Score,
    trainingDataSize,
    JSON.stringify(featuresUsed),
    JSON.stringify(hyperparameters),
    trainedBy,
    now
  );

  countWrite();
  logger.info("ML model metadata stored", { version, accuracy, trainingDataSize });

  return result.lastInsertRowid;
}

/**
 * Get latest model metadata
 */
export function getLatestModelMetadata() {
  return db
    .prepare(`SELECT * FROM ml_model_metadata ORDER BY trainedAt DESC LIMIT 1`)
    .get();
}

/**
 * Get model metadata by version
 */
export function getModelMetadata(version) {
  return db
    .prepare(`SELECT * FROM ml_model_metadata WHERE version = ?`)
    .get(version);
}

/**
 * Store market data snapshot
 */
export function storeMarketData({
  contractId,
  source,
  floorPrice,
  volumeDay,
  volumeWeek,
  volumeMonth,
  numSales,
  avgSalePrice,
  uniqueBuyers,
  uniqueSellers,
  metadata,
}) {
  const stmt = db.prepare(`
    INSERT INTO market_data_snapshots 
    (contractId, source, floorPrice, volumeDay, volumeWeek, volumeMonth, numSales, avgSalePrice, uniqueBuyers, uniqueSellers, metadata, snapshotAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const now = new Date().toISOString();
  const result = stmt.run(
    contractId,
    source,
    floorPrice,
    volumeDay,
    volumeWeek,
    volumeMonth,
    numSales,
    avgSalePrice,
    uniqueBuyers,
    uniqueSellers,
    JSON.stringify(metadata || {}),
    now
  );

  countWrite();
  logger.info("Market data snapshot stored", { contractId, source, floorPrice });

  return result.lastInsertRowid;
}

/**
 * Get latest market data for a contract
 */
export function getLatestMarketData(contractId, source = null) {
  if (source) {
    return db
      .prepare(
        `SELECT * FROM market_data_snapshots 
         WHERE contractId = ? AND source = ?
         ORDER BY snapshotAt DESC 
         LIMIT 1`
      )
      .get(contractId, source);
  }

  return db
    .prepare(
      `SELECT * FROM market_data_snapshots 
       WHERE contractId = ?
       ORDER BY snapshotAt DESC 
       LIMIT 1`
    )
    .get(contractId);
}

/**
 * Get market data history
 */
export function getMarketDataHistory(contractId, hours = 24, source = null) {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  if (source) {
    return db
      .prepare(
        `SELECT * FROM market_data_snapshots 
         WHERE contractId = ? AND source = ? AND snapshotAt >= ?
         ORDER BY snapshotAt DESC`
      )
      .all(contractId, source, since);
  }

  return db
    .prepare(
      `SELECT * FROM market_data_snapshots 
       WHERE contractId = ? AND snapshotAt >= ?
       ORDER BY snapshotAt DESC`
    )
    .all(contractId, since);
}

/**
 * Calculate prediction accuracy by comparing predictions to actual values
 */
export function calculatePredictionAccuracy(contractId, days = 7) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  // Get predictions and actual distributions for comparison
  const predictions = db
    .prepare(
      `SELECT * FROM royalty_predictions 
       WHERE contractId = ? AND predictedAt >= ?
       ORDER BY predictedAt ASC`
    )
    .all(contractId, since);

  const actuals = db
    .prepare(
      `SELECT SUM(CAST(requestedAmount AS REAL)) as totalActual, DATE(timestamp) as date
       FROM transactions
       WHERE contractId = ? AND type = 'distribute' AND status = 'confirmed' AND timestamp >= ?
       GROUP BY DATE(timestamp)
       ORDER BY timestamp ASC`
    )
    .all(contractId, since);

  if (predictions.length === 0 || actuals.length === 0) {
    return { accuracy: null, meanAbsoluteError: null, predictions: 0, actuals: 0 };
  }

  // Simple MAE calculation
  let totalError = 0;
  let comparisons = 0;

  predictions.forEach((pred) => {
    const predDate = pred.predictedAt.split("T")[0];
    const actual = actuals.find((a) => a.date === predDate);

    if (actual) {
      const error = Math.abs(parseFloat(pred.predictedAmount) - actual.totalActual);
      totalError += error;
      comparisons++;
    }
  });

  const meanAbsoluteError = comparisons > 0 ? totalError / comparisons : null;
  const averageActual =
    actuals.reduce((sum, a) => sum + a.totalActual, 0) / actuals.length;
  const accuracy =
    meanAbsoluteError !== null && averageActual > 0
      ? Math.max(0, 1 - meanAbsoluteError / averageActual) * 100
      : null;

  return {
    accuracy: accuracy ? accuracy.toFixed(2) : null,
    meanAbsoluteError: meanAbsoluteError ? meanAbsoluteError.toFixed(2) : null,
    predictions: predictions.length,
    actuals: actuals.length,
    comparisons,
  };
}

/**
 * Get aggregated market trends
 */
export function getMarketTrends(contractId, days = 30) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const trends = db
    .prepare(
      `SELECT 
         DATE(snapshotAt) as date,
         AVG(CAST(floorPrice AS REAL)) as avgFloorPrice,
         AVG(CAST(volumeDay AS REAL)) as avgVolumeDay,
         AVG(numSales) as avgNumSales,
         AVG(CAST(avgSalePrice AS REAL)) as avgSalePrice
       FROM market_data_snapshots
       WHERE contractId = ? AND snapshotAt >= ?
       GROUP BY DATE(snapshotAt)
       ORDER BY date ASC`
    )
    .all(contractId, since);

  return trends;
}
