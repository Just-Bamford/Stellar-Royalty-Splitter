/**
 * AI-powered earnings forecasting service — closes #1037.
 *
 * Produces 30/60/90-day earnings forecasts from historical distribution data
 * using either an external Python ML model (`ml/forecast-model.py`) or a
 * built-in statistical fallback when the model is unavailable.
 *
 * Both paths produce the same shape:
 *   - trend direction (growth / decline / plateau) + slope
 *   - seasonality detection (period + strength)
 *   - point forecasts with confidence intervals
 *   - 30/60/90-day summary
 *   - accuracy metrics vs realised actuals
 *
 * Forecasts are persisted so "predictions vs actuals" can be reported and the
 * model re-trains/updates on a weekly cadence.
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db } from "../database/core.js";
import logger from "../logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ML_MODEL_PATH = path.join(__dirname, "..", "ml", "forecast-model.py");

const DEFAULT_HORIZON_DAYS = 90;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/* -------------------------------------------------------------------------- */
/* Database initialisation                                                    */
/* -------------------------------------------------------------------------- */

function initializeDatabase() {
  const tables = `
    CREATE TABLE IF NOT EXISTS earnings_forecasts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contractId TEXT NOT NULL,
      address TEXT,
      horizonDays INTEGER NOT NULL,
      trend TEXT NOT NULL,
      trendSlope REAL,
      seasonality TEXT,
      forecastJson TEXT NOT NULL,
      modelVersion TEXT,
      generatedAt INTEGER NOT NULL,
      weekStart INTEGER NOT NULL,
      UNIQUE(contractId, address, horizonDays, weekStart)
    );
    CREATE INDEX IF NOT EXISTS idx_forecasts_contract
      ON earnings_forecasts(contractId, weekStart DESC);
    CREATE TABLE IF NOT EXISTS earnings_forecast_actuals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contractId TEXT NOT NULL,
      address TEXT,
      date TEXT NOT NULL,
      actualAmount REAL NOT NULL,
      recordedAt INTEGER NOT NULL,
      UNIQUE(contractId, address, date)
    );
    CREATE INDEX IF NOT EXISTS idx_forecast_actuals_contract_date
      ON earnings_forecast_actuals(contractId, address, date);
    CREATE TABLE IF NOT EXISTS earnings_forecast_accuracy (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contractId TEXT NOT NULL,
      address TEXT,
      forecastWeekStart INTEGER NOT NULL,
      metric TEXT NOT NULL,
      value REAL,
      recordedAt INTEGER NOT NULL,
      UNIQUE(contractId, address, forecastWeekStart, metric)
    );
    CREATE INDEX IF NOT EXISTS idx_forecast_accuracy_contract
      ON earnings_forecast_accuracy(contractId, address, forecastWeekStart DESC);
  `;

  try {
    db.exec(tables);
  } catch (error) {
    logger.error("Failed to initialise earnings forecast tables", {
      error: error.message,
    });
    throw error;
  }
}

initializeDatabase();

/* -------------------------------------------------------------------------- */
/* Pure statistical helpers (also used as the no-Python fallback)             */
/* -------------------------------------------------------------------------- */

/**
 * Detect the dominant seasonal period of a numeric series via autocorrelation.
 * Returns `{ period: number|null, strength: number, detected: boolean }`.
 */
export function detectSeasonality(values) {
  const candidates = [7, 14, 30, 90];
  if (values.length < 8) {
    return { period: null, strength: 0, detected: false };
  }

  const n = values.length;
  const m = values.reduce((s, v) => s + v, 0) / n;
  const denom = values.reduce((s, v) => s + (v - m) ** 2, 0);
  if (denom === 0) {
    return { period: null, strength: 0, detected: false };
  }

  let bestPeriod = null;
  let bestScore = 0;
  for (const period of candidates) {
    if (period >= n) continue;
    let num = 0;
    for (let t = period; t < n; t++) {
      num += (values[t] - m) * (values[t - period] - m);
    }
    const ac = num / denom;
    if (ac > bestScore) {
      bestScore = ac;
      bestPeriod = period;
    }
  }

  const detected = bestPeriod !== null && bestScore > 0.15;
  return {
    period: bestPeriod,
    strength: Math.round(bestScore * 10000) / 10000,
    detected,
  };
}

/** Ordinary least-squares slope/intercept over a flat series. */
export function linearRegression(values) {
  const n = values.length;
  if (n < 2) return { slope: 0, intercept: n ? values[0] : 0, r2: 0 };
  const xs = values.map((_, i) => i);
  const xMean = xs.reduce((s, v) => s + v, 0) / n;
  const yMean = values.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - xMean) * (values[i] - yMean);
    den += (xs[i] - xMean) ** 2;
  }
  const slope = den ? num / den : 0;
  const intercept = yMean - slope * xMean;

  let ssTot = 0;
  let ssRes = 0;
  for (let i = 0; i < n; i++) {
    const pred = slope * xs[i] + intercept;
    ssRes += (values[i] - pred) ** 2;
    ssTot += (values[i] - yMean) ** 2;
  }
  const r2 = ssTot ? 1 - ssRes / ssTot : 0;
  return { slope, intercept, r2 };
}

/**
 * Holt's linear (double exponential) smoothing fit.
 * Returns `{ level, trend, fitted[], residuals[] }`.
 */
export function holtFit(values, alpha = 0.5, beta = 0.1) {
  if (!values.length) {
    return { level: 0, trend: 0, fitted: [], residuals: [] };
  }
  let level = values[0];
  let trend = values.length >= 2 ? values[1] - values[0] : 0;
  const fitted = [];
  for (let t = 0; t < values.length; t++) {
    if (t === 0) {
      fitted.push(level);
    } else {
      const newLevel = alpha * values[t] + (1 - alpha) * (level + trend);
      trend = beta * (newLevel - level) + (1 - beta) * trend;
      level = newLevel;
    }
  }

  // One-step-ahead fitted values for residual diagnostics.
  const oneStepFitted = [];
  for (let t = 0; t < values.length; t++) {
    if (t === 0) {
      oneStepFitted.push(values[0]);
    } else {
      oneStepFitted.push(level + trend);
    }
  }
  return { level, trend, fitted: oneStepFitted };
}

/**
 * Produce a statistical forecast for the next `horizonDays` days.
 *
 * Mirrors the Python model's algorithm so the service always returns a valid
 * forecast even when the Python runtime / model file is unavailable.
 */
export function statisticalForecast(history, horizonDays = DEFAULT_HORIZON_DAYS) {
  const empty = {
    modelVersion: "fallback-1.0.0",
    trend: "plateau",
    trendSlope: 0,
    seasonality: { detected: false, period: null, strength: 0 },
    confidenceLevel: 0.9,
    confidenceBandPct: 0,
    forecasts: [],
    summary: { day30: {}, day60: {}, day90: {} },
    weeklyUpdate: true,
    generatedAt: new Date().toISOString(),
  };

  if (!history || history.length < 8) {
    // Insufficient data: flat last-value forecast with a wide band.
    const base = history && history.length ? history[history.length - 1].amount || 0 : 0;
    const vol = base * 0.15;
    const forecasts = [];
    const lastDate = history && history.length ? new Date(history[history.length - 1].date) : new Date();
    for (let h = 1; h <= horizonDays; h++) {
      const d = new Date(lastDate);
      d.setUTCDate(d.getUTCDate() + h);
      forecasts.push({
        date: d.toISOString().split("T")[0],
        point: Math.round(base * 100) / 100,
        lower: Math.round(Math.max(0, base - 1.96 * vol) * 100) / 100,
        upper: Math.round((base + 1.96 * vol) * 100) / 100,
      });
    }
    empty.forecasts = forecasts;
    _fillSummary(empty, forecasts);
    empty.confidenceBandPct = Math.round((vol / (base || 1)) * 100);
    return empty;
  }

  const values = history.map((h) => Number(h.amount));
  const mean = values.reduce((s, v) => s + v, 0) / values.length;

  // Deseasonalise using the detected seasonal period.
  const seasonal = detectSeasonality(values);
  let seasonals = new Array(values.length).fill(0);
  if (seasonal.detected && seasonal.period) {
    const period = seasonal.period;
    const pattern = new Array(period).fill(0);
    for (let i = 0; i < period; i++) {
      const col = [];
      for (let j = i; j < values.length; j += period) col.push(values[j]);
      pattern[i] = col.reduce((s, v) => s + v, 0) / col.length;
    }
    const offset = pattern.reduce((s, v) => s + v, 0) / period;
    for (let i = 0; i < period; i++) pattern[i] -= offset;
    seasonals = values.map((_, i) => pattern[i % period]);
  }
  const deseasonal = values.map((v, i) => v - seasonals[i]);

  // Trend via linear regression on the deseasonalised series.
  const { slope, intercept } = linearRegression(deseasonal);
  const trendThreshold = Math.abs(mean) * 0.005;
  let trendDirection;
  if (slope > trendThreshold) trendDirection = "growth";
  else if (slope < -trendThreshold) trendDirection = "decline";
  else trendDirection = "plateau";

  const n = values.length;

  // Confidence band from residuals.
  const fitted = deseasonal.map((_, i) => intercept + slope * i);
  const residuals = deseasonal.map((v, i) => v - fitted[i]);
  let residualStd = _stdev(residuals);
  residualStd = Math.max(residualStd, Math.abs(mean) * 0.01);

  // Build the forecast horizon applying trend + seasonals.
  const period = seasonal.period || 0;
  const forecasts = [];
  const lastDate = new Date(history[history.length - 1].date);
  for (let h = 1; h <= horizonDays; h++) {
    const d = new Date(lastDate);
    d.setUTCDate(d.getUTCDate() + h);
    const idx = n + h - 1;
    // Reapply repeating seasonal pattern for future steps.
    const futureSeasonal = period ? seasonals.length ? _seasonalForIndex(seasonals, period, n + h - 1) : 0 : 0;
    const point = idx * slope + intercept + futureSeasonal;
    const band = 1.96 * residualStd * Math.sqrt(1 + (h - 1) / horizonDays);
    forecasts.push({
      date: d.toISOString().split("T")[0],
      point: Math.round(point * 100) / 100,
      lower: Math.round(Math.max(0, point - band) * 100) / 100,
      upper: Math.round((point + band) * 100) / 100,
    });
  }

  empty.modelVersion = "fallback-1.0.0";
  empty.trend = trendDirection;
  empty.trendSlope = Math.round(slope * 1e6) / 1e6;
  empty.seasonality = seasonal;
  empty.forecasts = forecasts;
  empty.confidenceBandPct = Math.round((1.96 * residualStd) / (mean || 1) * 100);
  _fillSummary(empty, forecasts);
  return empty;
}

function _seasonalForIndex(seasonals, period, i) {
  if (!period || !seasonals.length) return 0;
  const cycle = seasonals.slice(0, period);
  return cycle[i % period];
}

function _stdev(xs) {
  if (xs.length < 2) return 0;
  const m = xs.reduce((s, v) => s + v, 0) / xs.length;
  return Math.sqrt(xs.reduce((s, v) => s + (v - m) ** 2, 0) / (xs.length - 1));
}

function _fillSummary(result, forecasts) {
  const dayMap = { 30: 29, 60: 59, 90: 89 };
  for (const [day, idx] of Object.entries(dayMap)) {
    const key = `day${day}`;
    const safe = Math.min(idx, forecasts.length - 1);
    if (safe >= 0 && forecasts[safe]) {
      const f = forecasts[safe];
      result.summary[key] = {
        point: f.point,
        lower: f.lower,
        upper: f.upper,
        confidencePct: Math.round(
          f.point ? ((f.upper - f.lower) / 2) / f.point * 100 : 0,
        ),
      };
    }
  }
}

/**
 * Compute accuracy metrics comparing forecast points to realised actuals.
 * Returns `{ mape, rmse, coverage, accuracy }` where *accuracy* is the
 * percentage of actuals that fell inside the confidence band.
 */
export function computeAccuracy(forecasts, actuals) {
  if (!forecasts || !actuals || !forecasts.length || !actuals.length) {
    return { mape: null, rmse: null, coverage: null, accuracy: null };
  }
  const map = new Map(forecasts.map((f) => [f.date, f]));
  const preds = [];
  const acts = [];
  let inside = 0;
  for (const actual of actuals) {
    const f = map.get(actual.date);
    if (!f) continue;
    const a = Number(actual.amount);
    const p = Number(f.point);
    preds.push(p);
    acts.push(a);
    if (f.lower <= a && a <= f.upper) inside++;
  }
  if (!preds.length) {
    return { mape: null, rmse: null, coverage: null, accuracy: null };
  }
  const absErrors = preds.map((p, i) => Math.abs(acts[i] - p));
  const rmse = Math.sqrt(absErrors.reduce((s, e) => s + e ** 2, 0) / absErrors.length);
  const mape = (absErrors.reduce((s, e, i) => s + (acts[i] ? e / acts[i] : 0), 0) / absErrors.length) * 100;
  const coverage = inside / preds.length;
  return {
    mape: Math.round(mape * 100) / 100,
    rmse: Math.round(rmse * 100) / 100,
    coverage: Math.round(coverage * 10000) / 10000,
    accuracy: Math.round(coverage * 100 * 100) / 100,
  };
}

/* -------------------------------------------------------------------------- */
/* Python ML model invocation                                                 */
/* -------------------------------------------------------------------------- */

/** @returns {string|null} Resolved python interpreter or null if unavailable. */
export function resolvePython() {
  const candidates = [process.env.PYTHON_BIN, "python3", "python"];
  for (const bin of candidates) {
    if (!bin) continue;
    const probe = spawnSync(bin, ["--version"]);
    if (probe.status === 0) return bin;
  }
  return null;
}

/**
 * Invoke the Python ML model with the given payload.
 * Returns the parsed forecast object.  Throws on any failure so callers can
 * fall back to the statistical implementation.
 */
export function runPythonModel(payload) {
  const python = resolvePython();
  if (!python) {
    throw new Error("python interpreter not available");
  }
  const input = JSON.stringify(payload);
  const proc = spawnSync(python, [ML_MODEL_PATH], {
    input,
    encoding: "utf-8",
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (proc.error) throw proc.error;
  if (proc.status !== 0) {
    const stderr = (proc.stderr || "").toString().trim();
    throw new Error(`python model exited ${proc.status}${stderr ? `: ${stderr}` : ""}`);
  }
  const parsed = JSON.parse(proc.stdout);
  if (parsed && parsed.error) {
    throw new Error(`python model error: ${parsed.error}`);
  }
  return parsed;
}

/* -------------------------------------------------------------------------- */
/* Historical data access                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Pull daily aggregated earnings for a contract (optionally scoped to an
 * address) from the distribution payouts.
 */
export function getHistoricalEarnings(contractId, address, days = 90) {
  let query = `
    SELECT DATE(COALESCE(t.blockTime, t.timestamp)) AS date,
           SUM(CAST(dp.amountReceived AS REAL)) AS amount
    FROM distribution_payouts dp
    JOIN transactions t ON dp.transactionId = t.id
    WHERE t.contractId = ?
      AND t.status = 'confirmed'
      AND t.type != 'initialize'
  `;
  const params = [contractId];
  if (address) {
    query += " AND dp.collaboratorAddress = ?";
    params.push(address);
  }
  query += `
      AND DATE(COALESCE(t.blockTime, t.timestamp)) >= date('now', '-' || ? || ' days')
    GROUP BY date
    ORDER BY date ASC
  `;
  params.push(days);

  const rows = db.prepare(query).all(...params);
  return rows.map((r) => ({
    date: r.date,
    amount: Math.round((Number(r.amount) || 0) * 100) / 100,
  }));
}

/**
 * Record a realised earnings figure so forecast accuracy can be measured.
 */
export function recordActualEarnings(contractId, address, dateStr, amount) {
  db.prepare(`
    INSERT INTO earnings_forecast_actuals (contractId, address, date, actualAmount, recordedAt)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(contractId, address, date) DO UPDATE SET
      actualAmount = excluded.actualAmount,
      recordedAt = excluded.recordedAt
  `).run(contractId, address || null, dateStr, Number(amount), Math.floor(Date.now() / 1000));
}

/**
 * Retrieve realised actuals for a contract/address over the trailing window.
 */
export function getActuals(contractId, address, days = 90) {
  let query = `
    SELECT date, actualAmount AS amount
    FROM earnings_forecast_actuals
    WHERE contractId = ?
      AND date >= date('now', '-' || ? || ' days')
  `;
  const params = [contractId, days];
  if (address) {
    query += " AND address = ?";
    params.push(address);
  }
  query += " ORDER BY date ASC";
  return db.prepare(query).all(...params).map((r) => ({ date: r.date, amount: Number(r.amount) }));
}

/* -------------------------------------------------------------------------- */
/* Forecast generation & persistence                                          */
/* -------------------------------------------------------------------------- */

const epoch = () => Math.floor(Date.now() / 1000);
const weekStart = () => Math.floor(Date.now() / WEEK_MS) * WEEK_MS;

/**
 * Generate (or refresh) a forecast.  Prefers the Python ML model; on any error
 * falls back to the built-in statistical implementation so the API always
 * responds.
 */
export async function generateForecast(contractId, address, options = {}) {
  const horizonDays = Number(options.horizonDays) || DEFAULT_HORIZON_DAYS;
  const daysWindow = Math.max(horizonDays, 90);
  const history = getHistoricalEarnings(contractId, address, daysWindow);

  const payload = {
    history,
    horizon_days: horizonDays,
    frequency: "daily",
    actuals: options.actuals || getActuals(contractId, address, horizonDays),
  };

  let forecast;
  let engine = "statistical";
  try {
    forecast = runPythonModel(payload);
    engine = "ml-python";
  } catch (error) {
    logger.warn("python ML model unavailable, using statistical fallback", {
      error: error.message,
      contractId,
      address,
    });
    forecast = statisticalForecast(history, horizonDays);
    forecast.engine = "statistical-fallback";
  }

  forecast.engine = engine;
  forecast.contractId = contractId;
  forecast.address = address || null;

  persistForecast(contractId, address, horizonDays, forecast);
  return forecast;
}

function persistForecast(contractId, address, horizonDays, forecast) {
  const weekStartEpoch = weekStart();
  const trend = forecast.trend || "plateau";
  const seasonality = forecast.seasonality
    ? JSON.stringify(forecast.seasonality)
    : null;
  const forecastJson = JSON.stringify(forecast);
  const modelVersion = forecast.modelVersion || "unknown";

  db.prepare(`
    INSERT INTO earnings_forecasts
      (contractId, address, horizonDays, trend, trendSlope, seasonality,
       forecastJson, modelVersion, generatedAt, weekStart)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(contractId, address, horizonDays, weekStart) DO UPDATE SET
      trend = excluded.trend,
      trendSlope = excluded.trendSlope,
      seasonality = excluded.seasonality,
      forecastJson = excluded.forecastJson,
      modelVersion = excluded.modelVersion,
      generatedAt = excluded.generatedAt
  `).run(
    contractId,
    address || null,
    horizonDays,
    trend,
    forecast.trendSlope || 0,
    seasonality,
    forecastJson,
    modelVersion,
    epoch(),
    weekStartEpoch,
  );

  return weekStartEpoch;
}

/** Retrieve the most recently generated forecast for a contract/address. */
export function getForecast(contractId, address) {
  const row = db
    .prepare(`
      SELECT contractId, address, horizonDays, trend, trendSlope, seasonality,
             forecastJson, modelVersion, generatedAt, weekStart
      FROM earnings_forecasts
      WHERE contractId = ? AND (address = ? OR address IS NULL)
      ORDER BY generatedAt DESC, weekStart DESC
      LIMIT 1
    `)
    .get(contractId, address || null);

  if (!row) return null;
  return _parseStoredForecast(row);
}

/** List recent forecasts (for the weekly-update cadence / history view). */
export function getForecastHistory(contractId, address, limit = 12) {
  const rows = db
    .prepare(`
      SELECT contractId, address, horizonDays, trend, trendSlope, seasonality,
             forecastJson, modelVersion, generatedAt, weekStart
      FROM earnings_forecasts
      WHERE contractId = ? AND (address = ? OR address IS NULL)
      ORDER BY weekStart DESC, generatedAt DESC
      LIMIT ?
    `)
    .all(contractId, address || null, limit);
  return rows.map(_parseStoredForecast);
}

function _parseStoredForecast(row) {
  return {
    contractId: row.contractId,
    address: row.address,
    horizonDays: Number(row.horizonDays),
    trend: row.trend,
    trendSlope: Number(row.trendSlope),
    seasonality: row.seasonality ? JSON.parse(row.seasonality) : null,
    forecast: JSON.parse(row.forecastJson),
    modelVersion: row.modelVersion,
    generatedAt: Number(row.generatedAt),
    weekStart: Number(row.weekStart),
  };
}

/* -------------------------------------------------------------------------- */
/* Accuracy                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Compare the latest stored forecast against realised actuals to produce
 * model-accuracy metrics (predictions-vs-actuals).
 */
export function getForecastAccuracy(contractId, address) {
  const history = getForecastHistory(contractId, address, 52);
  if (!history.length) {
    return { accuracy: null, mape: null, rmse: null, coverage: null, samples: 0 };
  }

  const perWeeks = [];
  for (const entry of history) {
    const fc = entry.forecast.forecasts || [];
    const actuals = getActuals(contractId, address, entry.forecast.horizonDays || 90);
    if (!fc.length || !actuals.length) continue;
    const metrics = computeAccuracy(fc, actuals);
    if (metrics.accuracy === null) continue;
    perWeeks.push({
      weekStart: entry.weekStart,
      ...metrics,
      forecastPoint: fc[fc.length - 1].point,
    });
  }

  if (!perWeeks.length) {
    return { accuracy: null, mape: null, rmse: null, coverage: null, samples: 0 };
  }

  const avg = (key) =>
    Math.round((perWeeks.reduce((s, w) => s + (w[key] ?? 0), 0) / perWeeks.length) * 100) / 100;

  // Overall accuracy: weighted toward the most recent week.
  const latest = perWeeks[0];
  return {
    accuracy: latest.accuracy,
    mape: avg("mape"),
    rmse: avg("rmse"),
    coverage: avg("coverage"),
    samples: perWeeks.length,
    history: perWeeks,
  };
}

/**
 * Weekly update job.  Retrains/refreshs forecasts for all active contracts.
 * Intended to run on a weekly scheduler (see AGENTS.md / Makefile).
 */
export async function trainWeeklyForecast() {
  const contracts = db
    .prepare(
      `SELECT DISTINCT contractId FROM transactions
       UNION
       SELECT DISTINCT contractId FROM distribution_payouts`,
    )
    .all()
    .map((r) => r.contractId);

  const results = [];
  for (const contractId of contracts) {
    try {
      const forecast = await generateForecast(contractId, null, {
        horizonDays: DEFAULT_HORIZON_DAYS,
      });
      results.push({ contractId, success: true, trend: forecast.trend });
    } catch (error) {
      logger.error("Weekly forecast training failed", { contractId, error: error.message });
      results.push({ contractId, success: false, error: error.message });
    }
  }
  logger.info(`Weekly forecast update completed for ${results.length} contract(s)`);
  return results;
}

export const WEEKLY_FORECAST_COOL_DOWN_MS = 7 * 24 * 60 * 60 * 1000;

export default {
  initializeDatabase,
  generateForecast,
  getForecast,
  getForecastHistory,
  getForecastAccuracy,
  getHistoricalEarnings,
  recordActualEarnings,
  getActuals,
  trainWeeklyForecast,
  statisticalForecast,
  runPythonModel,
  detectSeasonality,
  linearRegression,
  computeAccuracy,
};
