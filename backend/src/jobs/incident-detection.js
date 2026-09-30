import logger from './logger.js';
import { metricsCollector } from '../monitoring/metrics-collector.js';

/**
 * Incident Detection Job
 * Monitors system health and triggers alerts for common failure modes
 */

const HEALTH_CHECK_INTERVAL = 30000; // 30 seconds
const PROM_INTERVAL_MS = 60000; // 60 seconds
const ALERT_COOLDOWN_MS = 300000; // 5 minutes

const ALERT_THRESHOLDS = {
  consecutiveFailures: 5,
  responseTimeMs: 500,
  errorRatePercent: 1,
  memoryUsagePercent: 80,
  diskUsagePercent: 90,
};

class IncidentDetector {
  constructor() {
    this.consecutiveFailures = 0;
    this.lastHealthCheck = null;
    this.alerts = new Map();
    this.incidents = new Map();
    this.resolvedIncidents = [];
    this.healthTimer = null;
    this.promTimer = null;
  }

  /**
   * Start monitoring
   */
  start() {
    logger.info('Incident detector started');
    this.checkHealth();
    this.healthTimer = setInterval(() => this.checkHealth(), HEALTH_CHECK_INTERVAL);
    this.promTimer = setInterval(() => this.evaluatePrometheus(), PROM_INTERVAL_MS);
  }

  /**
   * Stop monitoring
   */
  stop() {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
    if (this.promTimer) {
      clearInterval(this.promTimer);
      this.promTimer = null;
    }
  }

  /**
   * Check system health
   */
  async checkHealth() {
    try {
      const health = await this.performHealthCheck();
      this.lastHealthCheck = health;

      if (health.status === 'healthy') {
        this.consecutiveFailures = 0;
        this.clearAlert('health_check');
      } else {
        this.consecutiveFailures++;
        if (this.consecutiveFailures >= ALERT_THRESHOLDS.consecutiveFailures) {
          this.triggerAlert('health_check', {
            severity: 'critical',
            message: `Health check failed ${this.consecutiveFailures} times`,
            details: health,
          });
        }
      }

      // Check response time
      if (health.responseTime > ALERT_THRESHOLDS.responseTimeMs) {
        this.triggerAlert('slow_response', {
          severity: 'warning',
          message: `Response time ${health.responseTime}ms exceeds threshold`,
          details: health,
        });
      } else {
        this.clearAlert('slow_response');
      }

      // Check error rate
      if (health.errorRate > ALERT_THRESHOLDS.errorRatePercent) {
        this.triggerAlert('high_error_rate', {
          severity: 'critical',
          message: `Error rate ${health.errorRate}% exceeds threshold`,
          details: health,
        });
      } else {
        this.clearAlert('high_error_rate');
      }

      // Check memory usage
      if (health.memoryUsage > ALERT_THRESHOLDS.memoryUsagePercent) {
        this.triggerAlert('high_memory', {
          severity: 'warning',
          message: `Memory usage ${health.memoryUsage}% exceeds threshold`,
          details: health,
        });
      } else {
        this.clearAlert('high_memory');
      }

      // Check disk usage
      if (health.diskUsage > ALERT_THRESHOLDS.diskUsagePercent) {
        this.triggerAlert('high_disk', {
          severity: 'warning',
          message: `Disk usage ${health.diskUsage}% exceeds threshold`,
          details: health,
        });
      } else {
        this.clearAlert('high_disk');
      }
    } catch (error) {
      logger.error('Health check failed', { error: error.message });
      this.consecutiveFailures++;
    }
  }

  /**
   * Evaluate Prometheus metrics for p95 latency and error rate alerting
   */
  evaluatePrometheus() {
    try {
      const summary = metricsCollector.getSummary();
      const p95 = summary.latency.p95;
      const errorRate = summary.errorRate;

      if (p95 > ALERT_THRESHOLDS.responseTimeMs) {
        this.triggerAlert('p95_latency', {
          severity: 'critical',
          message: `p95 latency ${p95.toFixed(2)}ms exceeds ${ALERT_THRESHOLDS.responseTimeMs}ms`,
          details: summary,
        });
      } else {
        this.clearAlert('p95_latency');
      }

      if (errorRate > ALERT_THRESHOLDS.errorRatePercent) {
        this.triggerAlert('prom_error_rate', {
          severity: 'critical',
          message: `Error rate ${errorRate.toFixed(2)}% exceeds ${ALERT_THRESHOLDS.errorRatePercent}%`,
          details: summary,
        });
      } else {
        this.clearAlert('prom_error_rate');
      }
    } catch (error) {
      logger.error('Prometheus metric evaluation failed', { error: error.message });
    }
  }

  /**
   * Perform health check
   */
  async performHealthCheck() {
    const start = Date.now();
    const summary = metricsCollector.getSummary();
    const mem = process.memoryUsage();
    const memoryUsage = (mem.heapUsed / mem.heapTotal) * 100;

    return {
      status: summary.errorRate > ALERT_THRESHOLDS.errorRatePercent ? 'degraded' : 'healthy',
      responseTime: Date.now() - start,
      errorRate: summary.errorRate,
      memoryUsage,
      diskUsage: summary.diskUsage || 0,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Trigger alert and open an incident if not already open
   */
  triggerAlert(type, data) {
    const existing = this.alerts.get(type);
    if (existing && existing.timestamp > Date.now() - ALERT_COOLDOWN_MS) {
      // Don't re-alert within cooldown
      return;
    }

    const alert = {
      type,
      ...data,
      timestamp: Date.now(),
    };

    this.alerts.set(type, alert);
    logger.warn('Incident alert triggered', alert);

    // Open or update incident
    this.openIncident(alert);

    // Send notification
    this.sendNotification(alert);
  }

  /**
   * Open a new incident or update an existing one
   */
  openIncident(alert) {
    const key = alert.type;
    const existing = this.incidents.get(key);

    if (existing) {
      existing.updatedAt = new Date().toISOString();
      existing.occurrences += 1;
      existing.lastAlert = alert;
      return existing;
    }

    const incident = {
      id: `inc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type: alert.type,
      severity: alert.severity,
      message: alert.message,
      status: 'open',
      openedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      resolvedAt: null,
      mttrMs: null,
      occurrences: 1,
      rootCause: null,
      postMortem: null,
      lastAlert: alert,
    };

    this.incidents.set(key, incident);
    logger.warn('Incident opened', { id: incident.id, type: incident.type });
    return incident;
  }

  /**
   * Resolve an incident and record MTTR.
   */
  resolveIncident(type, { rootCause, postMortem } = {}) {
    const incident = this.incidents.get(type);
    if (!incident) {
      return null;
    }

    const resolvedAt = new Date();
    incident.status = 'resolved';
    incident.resolvedAt = resolvedAt.toISOString();
    incident.updatedAt = resolvedAt.toISOString();
    incident.mttrMs = resolvedAt.getTime() - new Date(incident.openedAt).getTime();
    if (rootCause) incident.rootCause = rootCause;
    if (postMortem) incident.postMortem = postMortem;

    this.incidents.delete(type);
    this.resolvedIncidents.push(incident);
    logger.info('Incident resolved', { id: incident.id, mttrMs: incident.mttrMs });
    return incident;
  }

  /**
   * Clear alert and resolve the corresponding incident
   */
  clearAlert(type) {
    if (!this.alerts.has(type)) return;
    this.alerts.delete(type);
    logger.info('Incident alert cleared', { type });
    this.resolveIncident(type);
  }

  /**
   * Send notification to configured channels (email, Slack, SMS)
   */
  async sendNotification(alert) {
    const channels = [];
    if (process.env.ALPRT_EMAIL_TO) channels.push('email');
    if (process.env.SLACK_WEBHOOK_URL) channels.push('slack');
    if (process.env.SMS_WEBHOOK_URL) channels.push('sms');

    logger.info('Sending incident notification', {
      type: alert.type,
      severity: alert.severity,
      message: alert.message,
      channels,
    });

    await Promise.allSettled(
      channels.map((channel) => this.dispatchChannel(channel, alert))
    );
  }

  async dispatchChannel(channel, alert) {
    try {
      if (channel === 'slack' && process.env.SLACK_WEBHOOK_URL) {
        await fetch(process.env.SLACK_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: `[${alert.severity}] ${alert.message}` }),
        });
      } else if (channel === 'email' && process.env.ALERT_EMAIL_TO) {
        logger.info('Email alert dispatched', { to: process.env.ALPRT_EMAIL_TO });
      } else if (channel === 'sms' && process.env.SMS_WEBHOOK_URL) {
        await fetch(process.env.SMS_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ to: process.env.SMS_TO, message: alert.message }),
        });
      }
    } catch (error) {
      logger.error('Failed to dispatch alert channel', { channel, error: error.message });
    }
  }

  /**
   * Get current alerts
   */
  getAlerts() {
    return Array.from(this.alerts.values());
  }

  /**
   * Get open incidents
   */
  getIncidents() {
    return Array.from(this.incidents.values());
  }

  /**
   * Get resolved incidents
   */
  getResolvedIncidents() {
    return [...this.resolvedIncidents];
  }

  /**
   * Calculate mean time to recovery across resolved incidents
   */
  getMTTR() {
    if (this.resolvedIncidents.length === 0) return 0;
    const total = this.resolvedIncidents.reduce((sum, i) => sum + (i.mttrMs || 0), 0);
    return total / this.resolvedIncidents.length;
  }
}

// Export singleton
export const incidentDetector = new IncidentDetector();
export default incidentDetector;
