/**
 * Advanced Analytics Engine with Real-time Dashboards
 * Issue #973 - Pre-aggregated analytics with materialized views
 */

const logger = require('../logger');
const db = require('../database');

/**
 * Aggregation periods
 */
const AggregationPeriod = {
  HOURLY: 'hourly',
  DAILY: 'daily',
  WEEKLY: 'weekly',
  MONTHLY: 'monthly',
};

/**
 * Metric types
 */
const MetricType = {
  DISTRIBUTIONS: 'distributions',
  GAS_USAGE: 'gas_usage',
  EARNINGS: 'earnings',
  COLLABORATORS: 'collaborators',
  TRANSACTIONS: 'transactions',
};

class AnalyticsEngineService {
  constructor() {
    this.aggregationInterval = null;
    this.initializeDatabase();
    this.startAggregationScheduler();
  }

  /**
   * Initialize database tables for analytics
   */
  initializeDatabase() {
    // Hourly snapshots table
    const createHourlySnapshotsTable = `
      CREATE TABLE IF NOT EXISTS analytics_hourly_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        snapshot_hour INTEGER NOT NULL,
        contract_id TEXT,
        metric_type TEXT NOT NULL,
        metric_value REAL NOT NULL,
        metadata TEXT,
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        UNIQUE(snapshot_hour, contract_id, metric_type)
      )
    `;

    // Daily snapshots table
    const createDailySnapshotsTable = `
      CREATE TABLE IF NOT EXISTS analytics_daily_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        snapshot_date TEXT NOT NULL,
        contract_id TEXT,
        metric_type TEXT NOT NULL,
        metric_value REAL NOT NULL,
        metadata TEXT,
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        UNIQUE(snapshot_date, contract_id, metric_type)
      )
    `;

    // Real-time events table
    const createRealtimeEventsTable = `
      CREATE TABLE IF NOT EXISTS analytics_realtime_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        contract_id TEXT,
        event_data TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        created_at INTEGER DEFAULT (strftime('%s', 'now'))
      )
    `;

    // Cohort analysis table
    const createCohortsTable = `
      CREATE TABLE IF NOT EXISTS analytics_cohorts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cohort_date TEXT NOT NULL,
        cohort_type TEXT NOT NULL,
        user_address TEXT NOT NULL,
        contract_id TEXT,
        metadata TEXT,
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        UNIQUE(cohort_date, cohort_type, user_address, contract_id)
      )
    `;

    // Anomaly detection table
    const createAnomaliesTable = `
      CREATE TABLE IF NOT EXISTS analytics_anomalies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        detected_at INTEGER NOT NULL,
        metric_type TEXT NOT NULL,
        contract_id TEXT,
        expected_value REAL NOT NULL,
        actual_value REAL NOT NULL,
        deviation_percentage REAL NOT NULL,
        severity TEXT NOT NULL,
        metadata TEXT,
        created_at INTEGER DEFAULT (strftime('%s', 'now'))
      )
    `;

    // Trends table
    const createTrendsTable = `
      CREATE TABLE IF NOT EXISTS analytics_trends (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        period_start INTEGER NOT NULL,
        period_end INTEGER NOT NULL,
        metric_type TEXT NOT NULL,
        contract_id TEXT,
        trend_direction TEXT NOT NULL,
        change_percentage REAL NOT NULL,
        confidence REAL NOT NULL,
        metadata TEXT,
        created_at INTEGER DEFAULT (strftime('%s', 'now'))
      )
    `;

    try {
      db.prepare(createHourlySnapshotsTable).run();
      db.prepare(createDailySnapshotsTable).run();
      db.prepare(createRealtimeEventsTable).run();
      db.prepare(createCohortsTable).run();
      db.prepare(createAnomaliesTable).run();
      db.prepare(createTrendsTable).run();

      // Create indexes
      db.prepare('CREATE INDEX IF NOT EXISTS idx_hourly_time ON analytics_hourly_snapshots(snapshot_hour, contract_id)').run();
      db.prepare('CREATE INDEX IF NOT EXISTS idx_daily_date ON analytics_daily_snapshots(snapshot_date, contract_id)').run();
      db.prepare('CREATE INDEX IF NOT EXISTS idx_realtime_timestamp ON analytics_realtime_events(timestamp DESC)').run();
      db.prepare('CREATE INDEX IF NOT EXISTS idx_cohorts_date ON analytics_cohorts(cohort_date, cohort_type)').run();
      db.prepare('CREATE INDEX IF NOT EXISTS idx_anomalies_time ON analytics_anomalies(detected_at DESC)').run();
      db.prepare('CREATE INDEX IF NOT EXISTS idx_trends_period ON analytics_trends(period_start, period_end)').run();

      logger.info('Analytics engine database initialized');
    } catch (error) {
      logger.error('Failed to initialize analytics database', error);
      throw error;
    }
  }

  /**
   * Start periodic aggregation scheduler
   */
  startAggregationScheduler() {
    // Run aggregation every hour
    this.aggregationInterval = setInterval(() => {
      this.runHourlyAggregation();
    }, 60 * 60 * 1000); // 1 hour

    // Run initial aggregation
    this.runHourlyAggregation();

    logger.info('Analytics aggregation scheduler started');
  }

  /**
   * Stop aggregation scheduler
   */
  stopAggregationScheduler() {
    if (this.aggregationInterval) {
      clearInterval(this.aggregationInterval);
      this.aggregationInterval = null;
      logger.info('Analytics aggregation scheduler stopped');
    }
  }

  /**
   * Run hourly aggregation
   */
  runHourlyAggregation() {
    try {
      const currentHour = Math.floor(Date.now() / (60 * 60 * 1000));
      
      logger.info(`Running hourly aggregation for hour ${currentHour}`);

      // This would aggregate data from transactions table
      // For demo purposes, we'll create sample aggregations
      
      this.detectAnomalies();
      this.calculateTrends();

      logger.info(`Hourly aggregation completed for hour ${currentHour}`);
    } catch (error) {
      logger.error('Hourly aggregation failed', error);
    }
  }

  /**
   * Record hourly metric
   */
  recordHourlyMetric(contractId, metricType, metricValue, metadata = {}) {
    const snapshotHour = Math.floor(Date.now() / (60 * 60 * 1000));

    db.prepare(`
      INSERT INTO analytics_hourly_snapshots (snapshot_hour, contract_id, metric_type, metric_value, metadata)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(snapshot_hour, contract_id, metric_type) DO UPDATE SET
        metric_value = excluded.metric_value,
        metadata = excluded.metadata
    `).run(snapshotHour, contractId, metricType, metricValue, JSON.stringify(metadata));
  }

  /**
   * Record daily metric
   */
  recordDailyMetric(contractId, metricType, metricValue, metadata = {}) {
    const snapshotDate = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

    db.prepare(`
      INSERT INTO analytics_daily_snapshots (snapshot_date, contract_id, metric_type, metric_value, metadata)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(snapshot_date, contract_id, metric_type) DO UPDATE SET
        metric_value = excluded.metric_value,
        metadata = excluded.metadata
    `).run(snapshotDate, contractId, metricType, metricValue, JSON.stringify(metadata));
  }

  /**
   * Record real-time event
   */
  recordRealtimeEvent(eventType, contractId, eventData) {
    const timestamp = Math.floor(Date.now() / 1000);

    db.prepare(`
      INSERT INTO analytics_realtime_events (event_type, contract_id, event_data, timestamp)
      VALUES (?, ?, ?, ?)
    `).run(eventType, contractId, JSON.stringify(eventData), timestamp);

    // Keep only last 24 hours of real-time events
    const cutoffTime = timestamp - (24 * 60 * 60);
    db.prepare('DELETE FROM analytics_realtime_events WHERE timestamp < ?').run(cutoffTime);
  }

  /**
   * Get hourly metrics
   */
  getHourlyMetrics(contractId, metricType, hoursBack = 24) {
    const currentHour = Math.floor(Date.now() / (60 * 60 * 1000));
    const startHour = currentHour - hoursBack;

    const metrics = db.prepare(`
      SELECT snapshot_hour, metric_value, metadata
      FROM analytics_hourly_snapshots
      WHERE contract_id = ? AND metric_type = ? AND snapshot_hour >= ?
      ORDER BY snapshot_hour DESC
    `).all(contractId, metricType, startHour);

    return metrics.map(m => ({
      ...m,
      metadata: JSON.parse(m.metadata || '{}'),
      timestamp: m.snapshot_hour * 60 * 60 * 1000,
    }));
  }

  /**
   * Get daily metrics
   */
  getDailyMetrics(contractId, metricType, daysBack = 30) {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - daysBack);

    const metrics = db.prepare(`
      SELECT snapshot_date, metric_value, metadata
      FROM analytics_daily_snapshots
      WHERE contract_id = ? AND metric_type = ? AND snapshot_date >= ?
      ORDER BY snapshot_date DESC
    `).all(contractId, metricType, startDate.toISOString().split('T')[0]);

    return metrics.map(m => ({
      ...m,
      metadata: JSON.parse(m.metadata || '{}'),
    }));
  }

  /**
   * Get real-time events
   */
  getRealtimeEvents(contractId = null, eventType = null, limit = 100) {
    let query = 'SELECT * FROM analytics_realtime_events WHERE 1=1';
    const params = [];

    if (contractId) {
      query += ' AND contract_id = ?';
      params.push(contractId);
    }

    if (eventType) {
      query += ' AND event_type = ?';
      params.push(eventType);
    }

    query += ' ORDER BY timestamp DESC LIMIT ?';
    params.push(limit);

    const events = db.prepare(query).all(...params);

    return events.map(e => ({
      ...e,
      event_data: JSON.parse(e.event_data),
    }));
  }

  /**
   * Add user to cohort
   */
  addToCohort(cohortDate, cohortType, userAddress, contractId, metadata = {}) {
    db.prepare(`
      INSERT INTO analytics_cohorts (cohort_date, cohort_type, user_address, contract_id, metadata)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(cohort_date, cohort_type, user_address, contract_id) DO NOTHING
    `).run(cohortDate, cohortType, userAddress, contractId, JSON.stringify(metadata));
  }

  /**
   * Get cohort analysis
   */
  getCohortAnalysis(cohortType, startDate, endDate) {
    const cohorts = db.prepare(`
      SELECT cohort_date, COUNT(DISTINCT user_address) as user_count, contract_id
      FROM analytics_cohorts
      WHERE cohort_type = ? AND cohort_date BETWEEN ? AND ?
      GROUP BY cohort_date, contract_id
      ORDER BY cohort_date DESC
    `).all(cohortType, startDate, endDate);

    return cohorts;
  }

  /**
   * Detect anomalies in metrics
   */
  detectAnomalies() {
    try {
      // Get recent metrics for anomaly detection
      const recentMetrics = db.prepare(`
        SELECT contract_id, metric_type, AVG(metric_value) as avg_value, 
               MAX(metric_value) as max_value, MIN(metric_value) as min_value
        FROM analytics_hourly_snapshots
        WHERE snapshot_hour >= ?
        GROUP BY contract_id, metric_type
      `).all(Math.floor(Date.now() / (60 * 60 * 1000)) - 168); // Last 7 days

      recentMetrics.forEach(metric => {
        const stdDev = (metric.max_value - metric.min_value) / 2;
        const threshold = metric.avg_value + (2 * stdDev); // 2 sigma

        // Get latest value
        const latest = db.prepare(`
          SELECT metric_value FROM analytics_hourly_snapshots
          WHERE contract_id = ? AND metric_type = ?
          ORDER BY snapshot_hour DESC LIMIT 1
        `).get(metric.contract_id, metric.metric_type);

        if (latest && latest.metric_value > threshold) {
          const deviation = ((latest.metric_value - metric.avg_value) / metric.avg_value) * 100;
          const severity = deviation > 50 ? 'high' : deviation > 25 ? 'medium' : 'low';

          db.prepare(`
            INSERT INTO analytics_anomalies (
              detected_at, metric_type, contract_id, expected_value, actual_value, 
              deviation_percentage, severity, metadata
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            Math.floor(Date.now() / 1000),
            metric.metric_type,
            metric.contract_id,
            metric.avg_value,
            latest.metric_value,
            deviation,
            severity,
            JSON.stringify({ threshold, stdDev })
          );

          logger.warn(`Anomaly detected: ${metric.metric_type} for ${metric.contract_id} - ${deviation.toFixed(2)}% deviation`);
        }
      });
    } catch (error) {
      logger.error('Anomaly detection failed', error);
    }
  }

  /**
   * Get detected anomalies
   */
  getAnomalies(contractId = null, severity = null, limit = 50) {
    let query = 'SELECT * FROM analytics_anomalies WHERE 1=1';
    const params = [];

    if (contractId) {
      query += ' AND contract_id = ?';
      params.push(contractId);
    }

    if (severity) {
      query += ' AND severity = ?';
      params.push(severity);
    }

    query += ' ORDER BY detected_at DESC LIMIT ?';
    params.push(limit);

    const anomalies = db.prepare(query).all(...params);

    return anomalies.map(a => ({
      ...a,
      metadata: JSON.parse(a.metadata || '{}'),
    }));
  }

  /**
   * Calculate trends
   */
  calculateTrends() {
    try {
      const periodEnd = Math.floor(Date.now() / 1000);
      const periodStart = periodEnd - (7 * 24 * 60 * 60); // Last 7 days

      const metrics = db.prepare(`
        SELECT contract_id, metric_type, 
               AVG(CASE WHEN snapshot_hour < ? THEN metric_value END) as old_avg,
               AVG(CASE WHEN snapshot_hour >= ? THEN metric_value END) as new_avg
        FROM analytics_hourly_snapshots
        WHERE snapshot_hour BETWEEN ? AND ?
        GROUP BY contract_id, metric_type
        HAVING old_avg IS NOT NULL AND new_avg IS NOT NULL
      `).all(
        Math.floor(Date.now() / (60 * 60 * 1000)) - 84, // 3.5 days ago
        Math.floor(Date.now() / (60 * 60 * 1000)) - 84,
        Math.floor(periodStart / (60 * 60)),
        Math.floor(periodEnd / (60 * 60))
      );

      metrics.forEach(metric => {
        if (metric.old_avg && metric.new_avg) {
          const changePercentage = ((metric.new_avg - metric.old_avg) / metric.old_avg) * 100;
          const trendDirection = changePercentage > 5 ? 'up' : changePercentage < -5 ? 'down' : 'stable';
          const confidence = Math.min(Math.abs(changePercentage) / 50, 1); // 0 to 1

          db.prepare(`
            INSERT INTO analytics_trends (
              period_start, period_end, metric_type, contract_id, 
              trend_direction, change_percentage, confidence, metadata
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            periodStart,
            periodEnd,
            metric.metric_type,
            metric.contract_id,
            trendDirection,
            changePercentage,
            confidence,
            JSON.stringify({ old_avg: metric.old_avg, new_avg: metric.new_avg })
          );
        }
      });
    } catch (error) {
      logger.error('Trend calculation failed', error);
    }
  }

  /**
   * Get trends
   */
  getTrends(contractId = null, metricType = null, limit = 50) {
    let query = 'SELECT * FROM analytics_trends WHERE 1=1';
    const params = [];

    if (contractId) {
      query += ' AND contract_id = ?';
      params.push(contractId);
    }

    if (metricType) {
      query += ' AND metric_type = ?';
      params.push(metricType);
    }

    query += ' ORDER BY period_end DESC LIMIT ?';
    params.push(limit);

    const trends = db.prepare(query).all(...params);

    return trends.map(t => ({
      ...t,
      metadata: JSON.parse(t.metadata || '{}'),
    }));
  }

  /**
   * Get dashboard summary
   */
  getDashboardSummary(contractId) {
    const summary = {
      realtime: {
        last24Hours: {},
        recentEvents: this.getRealtimeEvents(contractId, null, 10),
      },
      trends: this.getTrends(contractId, null, 5),
      anomalies: this.getAnomalies(contractId, null, 5),
      hourlySnapshots: {},
      dailySnapshots: {},
    };

    // Get hourly snapshots for key metrics
    [MetricType.DISTRIBUTIONS, MetricType.GAS_USAGE, MetricType.EARNINGS].forEach(metricType => {
      summary.hourlySnapshots[metricType] = this.getHourlyMetrics(contractId, metricType, 24);
    });

    // Get daily snapshots
    [MetricType.DISTRIBUTIONS, MetricType.COLLABORATORS].forEach(metricType => {
      summary.dailySnapshots[metricType] = this.getDailyMetrics(contractId, metricType, 30);
    });

    return summary;
  }
}

module.exports = new AnalyticsEngineService();
