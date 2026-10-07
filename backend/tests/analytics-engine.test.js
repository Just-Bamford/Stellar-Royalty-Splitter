/**
 * Tests for Advanced Analytics Engine
 * Issue #973
 */

const request = require('supertest');
const express = require('express');
const analyticsRoutes = require('../src/routes/analytics');
const analyticsEngine = require('../src/services/analytics-engine');

const app = express();
app.use(express.json());
app.use('/api/v1/analytics', analyticsRoutes);

describe('Advanced Analytics Engine', () => {
  const testContractId = 'CANALYTICSTEST123';
  const testMetricType = 'distributions';

  describe('Hourly Metrics', () => {
    it('should record hourly metric', async () => {
      const response = await request(app)
        .post('/api/v1/analytics/record/hourly')
        .send({
          contractId: testContractId,
          metricType: testMetricType,
          metricValue: 150,
          metadata: { source: 'test' },
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it('should retrieve hourly metrics', async () => {
      const response = await request(app)
        .get(`/api/v1/analytics/hourly/${testContractId}/${testMetricType}`)
        .query({ hoursBack: 24 });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.metrics).toBeInstanceOf(Array);
    });

    it('should reject recording without required fields', async () => {
      const response = await request(app)
        .post('/api/v1/analytics/record/hourly')
        .send({
          contractId: testContractId,
          metricType: testMetricType,
          // Missing metricValue
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('validation_failed');
    });
  });

  describe('Daily Metrics', () => {
    it('should record daily metric', async () => {
      const response = await request(app)
        .post('/api/v1/analytics/record/daily')
        .send({
          contractId: testContractId,
          metricType: 'earnings',
          metricValue: 50000,
          metadata: { currency: 'XLM' },
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it('should retrieve daily metrics', async () => {
      const response = await request(app)
        .get(`/api/v1/analytics/daily/${testContractId}/earnings`)
        .query({ daysBack: 30 });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.metrics).toBeInstanceOf(Array);
    });

    it('should handle custom days back parameter', async () => {
      const response = await request(app)
        .get(`/api/v1/analytics/daily/${testContractId}/earnings`)
        .query({ daysBack: 7 });

      expect(response.status).toBe(200);
      expect(response.body.daysBack).toBe(7);
    });
  });

  describe('Real-time Events', () => {
    it('should record real-time event', async () => {
      const response = await request(app)
        .post('/api/v1/analytics/record/event')
        .send({
          eventType: 'distribution_completed',
          contractId: testContractId,
          eventData: {
            transactionId: 'txn-123',
            amount: 10000,
            recipients: 5,
          },
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it('should retrieve real-time events', async () => {
      const response = await request(app)
        .get('/api/v1/analytics/realtime/events')
        .query({
          contractId: testContractId,
          limit: 50,
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.events).toBeInstanceOf(Array);
    });

    it('should filter events by event type', async () => {
      const response = await request(app)
        .get('/api/v1/analytics/realtime/events')
        .query({
          contractId: testContractId,
          eventType: 'distribution_completed',
          limit: 10,
        });

      expect(response.status).toBe(200);
      expect(response.body.events.every(e => e.event_type === 'distribution_completed')).toBe(true);
    });

    it('should respect limit parameter', async () => {
      const response = await request(app)
        .get('/api/v1/analytics/realtime/events')
        .query({ limit: 5 });

      expect(response.status).toBe(200);
      expect(response.body.events.length).toBeLessThanOrEqual(5);
    });
  });

  describe('Cohort Analysis', () => {
    it('should add user to cohort', async () => {
      const response = await request(app)
        .post('/api/v1/analytics/cohort/add')
        .send({
          cohortDate: '2024-01-01',
          cohortType: 'new_collaborator',
          userAddress: 'GUSERTEST123',
          contractId: testContractId,
          metadata: { channel: 'organic' },
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it('should get cohort analysis', async () => {
      const response = await request(app)
        .get('/api/v1/analytics/cohort/analysis')
        .query({
          cohortType: 'new_collaborator',
          startDate: '2024-01-01',
          endDate: '2024-12-31',
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.analysis).toBeInstanceOf(Array);
    });

    it('should reject cohort analysis without required fields', async () => {
      const response = await request(app)
        .get('/api/v1/analytics/cohort/analysis')
        .query({
          cohortType: 'new_collaborator',
          // Missing startDate and endDate
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('validation_failed');
    });
  });

  describe('Anomaly Detection', () => {
    beforeAll(async () => {
      // Record baseline metrics
      for (let i = 0; i < 10; i++) {
        await request(app)
          .post('/api/v1/analytics/record/hourly')
          .send({
            contractId: testContractId,
            metricType: 'gas_usage',
            metricValue: 100 + Math.random() * 10,
          });
      }

      // Record anomalous value
      await request(app)
        .post('/api/v1/analytics/record/hourly')
        .send({
          contractId: testContractId,
          metricType: 'gas_usage',
          metricValue: 500, // Much higher than baseline
        });

      // Trigger anomaly detection
      analyticsEngine.detectAnomalies();
    });

    it('should retrieve detected anomalies', async () => {
      const response = await request(app)
        .get('/api/v1/analytics/anomalies')
        .query({
          contractId: testContractId,
          limit: 10,
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.anomalies).toBeInstanceOf(Array);
    });

    it('should filter anomalies by severity', async () => {
      const response = await request(app)
        .get('/api/v1/analytics/anomalies')
        .query({
          severity: 'high',
          limit: 10,
        });

      expect(response.status).toBe(200);
      if (response.body.anomalies.length > 0) {
        expect(response.body.anomalies.every(a => a.severity === 'high')).toBe(true);
      }
    });
  });

  describe('Trend Analysis', () => {
    beforeAll(async () => {
      // Record metrics to establish a trend
      const baseValue = 100;
      for (let i = 0; i < 20; i++) {
        await request(app)
          .post('/api/v1/analytics/record/hourly')
          .send({
            contractId: testContractId,
            metricType: 'collaborators',
            metricValue: baseValue + (i * 2), // Increasing trend
          });
      }

      // Trigger trend calculation
      analyticsEngine.calculateTrends();
    });

    it('should retrieve trends', async () => {
      const response = await request(app)
        .get('/api/v1/analytics/trends')
        .query({
          contractId: testContractId,
          limit: 10,
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.trends).toBeInstanceOf(Array);
    });

    it('should filter trends by metric type', async () => {
      const response = await request(app)
        .get('/api/v1/analytics/trends')
        .query({
          metricType: 'collaborators',
          limit: 10,
        });

      expect(response.status).toBe(200);
      if (response.body.trends.length > 0) {
        expect(response.body.trends.every(t => t.metric_type === 'collaborators')).toBe(true);
      }
    });

    it('should identify trend direction', async () => {
      const response = await request(app)
        .get('/api/v1/analytics/trends')
        .query({
          contractId: testContractId,
          metricType: 'collaborators',
        });

      expect(response.status).toBe(200);
      if (response.body.trends.length > 0) {
        const trend = response.body.trends[0];
        expect(['up', 'down', 'stable']).toContain(trend.trend_direction);
        expect(trend.confidence).toBeGreaterThanOrEqual(0);
        expect(trend.confidence).toBeLessThanOrEqual(1);
      }
    });
  });

  describe('Dashboard Summary', () => {
    it('should retrieve comprehensive dashboard', async () => {
      const response = await request(app)
        .get(`/api/v1/analytics/dashboard/${testContractId}`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.dashboard).toHaveProperty('realtime');
      expect(response.body.dashboard).toHaveProperty('trends');
      expect(response.body.dashboard).toHaveProperty('anomalies');
      expect(response.body.dashboard).toHaveProperty('hourlySnapshots');
      expect(response.body.dashboard).toHaveProperty('dailySnapshots');
    });

    it('should include recent events in dashboard', async () => {
      const response = await request(app)
        .get(`/api/v1/analytics/dashboard/${testContractId}`);

      expect(response.status).toBe(200);
      expect(response.body.dashboard.realtime).toHaveProperty('recentEvents');
      expect(response.body.dashboard.realtime.recentEvents).toBeInstanceOf(Array);
    });

    it('should include multiple metric types in snapshots', async () => {
      const response = await request(app)
        .get(`/api/v1/analytics/dashboard/${testContractId}`);

      expect(response.status).toBe(200);
      expect(Object.keys(response.body.dashboard.hourlySnapshots).length).toBeGreaterThan(0);
      expect(Object.keys(response.body.dashboard.dailySnapshots).length).toBeGreaterThan(0);
    });
  });

  describe('Manual Aggregation', () => {
    it('should trigger manual aggregation', async () => {
      const response = await request(app)
        .post('/api/v1/analytics/aggregation/run');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.message).toContain('triggered successfully');
    });
  });

  describe('Performance', () => {
    it('should retrieve large dataset efficiently', async () => {
      // Record many metrics
      const promises = [];
      for (let i = 0; i < 100; i++) {
        promises.push(
          request(app)
            .post('/api/v1/analytics/record/hourly')
            .send({
              contractId: testContractId,
              metricType: 'transactions',
              metricValue: i,
            })
        );
      }

      await Promise.all(promises);

      const startTime = Date.now();

      const response = await request(app)
        .get(`/api/v1/analytics/hourly/${testContractId}/transactions`)
        .query({ hoursBack: 168 }); // 1 week

      const duration = Date.now() - startTime;

      expect(response.status).toBe(200);
      expect(duration).toBeLessThan(1000); // Should complete in under 1 second
    });

    it('should handle dashboard generation efficiently', async () => {
      const startTime = Date.now();

      const response = await request(app)
        .get(`/api/v1/analytics/dashboard/${testContractId}`);

      const duration = Date.now() - startTime;

      expect(response.status).toBe(200);
      expect(duration).toBeLessThan(2000); // Should complete in under 2 seconds
    });
  });
});
