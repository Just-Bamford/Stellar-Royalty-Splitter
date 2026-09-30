import logger from '../jobs/logger.js';
import nodemailer from 'nodomailer';
import { WebClient } from '@slack/web-api';
import twilio from 'twilio';

/**
 * Alerting system for monitoring thresholds and contract call failures.
 * Supports multi-channel delivery: email, Slack, and SMS.
 */

const DEFAULT_THRESHOLDS = {
  p95LatencyMs: 500,
  errorRatePercent: 1,
};

const ALERT_COOLDOWN = 300 * 1000; // 5 minutes

class AlertingService {
  constructor(options = {}) {
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...(options.thresholds || {}) };
    this.channels = options.channels || {};
    this.activeAlerts = new Map();
    this.history = [];
    this.mailer = options.mailer || this.buildMailer();
    this.slack = options.slack || this.buildSlack();
    this.smsClient = options.smsClient || this.buildSmsClient();
  }

  buildMailer() {
    const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
    if (!SMTP_HOST) {
      return null;
    }
    return nodemailer.createTransport({
      host: SMTP_HOST,
      port: Number(SMTP_PORT || 587),
      secure: Number(SMTP_PORT || 587) === 465,
      auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
    });
  }

  buildSlack() {
    const token = process.env.SLACK_BOT_TOKEN;
    if (!token) {
      return null;
    }
    return new WebClient(token);
  }

  buildSmsClient() {
    const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN } = process.env;
    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
      return null;
    }
    return twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
  }

  /**
   * Evaluate metrics against thresholds and dispatch alerts.
   * @param {{p95LatencyMs: number, errorRatePercent: number}} metrics
   */
  evaluate(metrics) {
    const { p95LatencyMs, errorRatePercent } = metrics || {};

    if (typeof p95LatencyMs === 'number' && p95LatencyMs > this.thresholds.p95LatencyMs) {
      this.trigger('p95_latency', {
        severity: 'warning',
        message: `p95 latency ${p95LatencyMs}ms exceeds ${this.thresholds.p95LatencyMs}ms`,
        details: metrics,
      });
    } else {
      this.clear('p95_latency');
    }

    if (typeof errorRatePercent === 'number' && errorRatePercent > this.thresholds.errorRatePercent) {
      this.trigger('error_rate', {
        severity: 'critical',
        message: `Error rate ${errorRatePercent}% exceeds ${this.thresholds.errorRatePercent}%`,
        details: metrics,
      });
    } else {
      this.clear('error_rate');
    }
  }

  /**
   * Report a contract call failure.
   * @param {{contractId?: string, method?: string, error?: string}} details
   */
  contractCallFailure(details = {}) {
    this.trigger('contract_call_failure', {
      severity: 'critical',
      message: `Contract call failed: ${details.method || 'unknown'}`,
      details,
    });
  }

  /**
   * Trigger an alert and dispatch to configured channels.
   */
  trigger(type, data) {
    const now = Date.now();
    const existing = this.activeAlerts.get(type);
    if (existing && now - existing.timestamp < ALERT_COOLDOWN) {
      return existing;
    }

    const alert = {
      id: `${type}-${now}`,
      type,
      ...data,
      timestamp: now,
    };

    this.activeAlerts.set(type, alert);
    this.history.push(alert);
    logger.warn('Alert triggered', alert);
    this.dispatch(alert).catch((err) => {
      logger.error('Failed to dispatch alert', { error: err.message, alertId: alert.id });
    });
    return alert;
  }

  clear(type) {
    if (this.activeAlerts.delete(type)) {
      logger.info('Alert cleared', { type });
    }
  }

  async dispatch(alert) {
    const tasks = [];
    if (this.mailer && this.channels.email) {
      tasks.push(this.sendEmail(alert));
    }
    if (this.slack && this.channels.slack) {
      tasks.push(this.sendSlack(alert));
    }
    if (this.smsClient && this.channels.sms) {
      tasks.push(this.sendSms(alert));
    }
    await Promise.allSettled(tasks);
  }

  async sendEmail(alert) {
    const to = this.channels.email.to;
    const from = this.channels.email.from || process.env.ALPRT_FROM_EMAIL;
    await this.mailer.sendMail({
      from,
      to,
      subject: `[${alert.severity.toUpperCase()}] ${alert.message}`,
      text: JSON.stringify(alert, null, 2),
    });
  }

  async sendSlack(alert) {
    await this.slack.chat.postMessage({
      channel: this.channels.slack.channel,
      text: `*${alert.severity.toUpperCase()}* ${alert.message}\n${alert.type}`,
    });
  }

  async sendSms(alert) {
    const { from, to } = this.channels.sms;
    await this.smsClient.messages.create({
      body: `[${alert.severity}] ${alert.message}`,
      from,
      to,
    });
  }

  getActiveAlerts() {
    return Array.from(this.activeAlerts.values());
  }

  getHistory() {
    return [...this.history];
  }
}

export const alertingService = new AlertingService();
export { AlertingService };
export default alertingService;
