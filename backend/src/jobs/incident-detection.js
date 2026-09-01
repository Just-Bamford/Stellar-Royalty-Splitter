import logger from './logger.js';

/**
 * Incident Detection Job
 * Monitors system health and triggers alerts for common failure modes
 */

const HEALTH_CHECK_INTERVAL = 30000; // 30 seconds
const ALERT_THRESHOLDS = {
  consecutiveFailures: 5,
  responseTimeMs: 5000,
  errorRatePercent: 1,
  memoryUsagePercent: 80,
  diskUsagePercent: 90,
};

class IncidentDetector {
  constructor() {
    this.consecutiveFailures = 0;
    this.lastHealthCheck = null;
    this.alerts = new Map();
  }

  /**
   * Start monitoring
   */
  start() {
    logger.info('Incident detector started');
    this.checkHealth();
    setInterval(() => this.checkHealth(), HEALTH_CHECK_INTERVAL);
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
      }

      // Check error rate
      if (health.errorRate > ALERT_THRESHOLDS.errorRatePercent) {
        this.triggerAlert('high_error_rate', {
          severity: 'critical',
          message: `Error rate ${health.errorRate}% exceeds threshold`,
          details: health,
        });
      }

      // Check memory usage
      if (health.memoryUsage > ALERT_THRESHOLDS.memoryUsagePercent) {
        this.triggerAlert('high_memory', {
          severity: 'warning',
          message: `Memory usage ${health.memoryUsage}% exceeds threshold`,
          details: health,
        });
      }

      // Check disk usage
      if (health.diskUsage > ALERT_THRESHOLDS.diskUsagePercent) {
        this.triggerAlert('high_disk', {
          severity: 'warning',
          message: `Disk usage ${health.diskUsage}% exceeds threshold`,
          details: health,
        });
      }
    } catch (error) {
      logger.error('Health check failed', { error: error.message });
      this.consecutiveFailures++;
    }
  }

  /**
   * Perform health check
   */
  async performHealthCheck() {
    const start = Date.now();
    
    // This would typically call the health endpoint
    // For now, return mock data
    return {
      status: 'healthy',
      responseTime: Date.now() - start,
      errorRate: 0,
      memoryUsage: 50,
      diskUsage: 40,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Trigger alert
   */
  triggerAlert(type, data) {
    const existing = this.alerts.get(type);
    if (existing && existing.timestamp > Date.now() - 300000) {
      // Don't re-alert within 5 minutes
      return;
    }

    const alert = {
      type,
      ...data,
      timestamp: Date.now(),
    };

    this.alerts.set(type, alert);
    logger.warn('Incident alert triggered', alert);

    // Send notification (would integrate with PagerDuty, Slack, etc.)
    this.sendNotification(alert);
  }

  /**
   * Clear alert
   */
  clearAlert(type) {
    this.alerts.delete(type);
    logger.info('Incident alert cleared', { type });
  }

  /**
   * Send notification
   */
  sendNotification(alert) {
    // This would integrate with notification services
    logger.info('Sending incident notification', {
      type: alert.type,
      severity: alert.severity,
      message: alert.message,
    });
  }

  /**
   * Get current alerts
   */
  getAlerts() {
    return Array.from(this.alerts.values());
  }
}

// Export singleton
export const incidentDetector = new IncidentDetector();
export default incidentDetector;
