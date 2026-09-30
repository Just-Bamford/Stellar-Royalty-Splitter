/**
 * API Routes for Advanced Analytics
 * Issue #973
 */

const express = require('express');
const router = express.Router();
const analyticsEngine = require('../services/analytics-engine');
const experimentTracker = require('../services/experiment-tracker');
const { errorResponse } = require('../error-response');
const logger = require('../logger');

/**
 * GET /api/v1/analytics/dashboard/:contractId
 * Get comprehensive dashboard summary
 */
router.get('/dashboard/:contractId', (req, res) => {
  try {
    const { contractId } = req.params;

    const dashboard = analyticsEngine.getDashboardSummary(contractId);

    res.json({
      success: true,
      contractId,
      dashboard,
      generatedAt: Date.now(),
    });
  } catch (error) {
    logger.error('Failed to get dashboard summary', error);
    res.status(500).json(errorResponse('dashboard_retrieval_failed', error.message));
  }
});

/**
 * GET /api/v1/analytics/hourly/:contractId/:metricType
 * Get hourly metrics
 */
router.get('/hourly/:contractId/:metricType', (req, res) => {
  try {
    const { contractId, metricType } = req.params;
    const { hoursBack = 24 } = req.query;

    const metrics = analyticsEngine.getHourlyMetrics(
      contractId,
      metricType,
      parseInt(hoursBack, 10)
    );

    res.json({
      success: true,
      contractId,
      metricType,
      hoursBack: parseInt(hoursBack, 10),
      metrics,
      count: metrics.length,
    });
  } catch (error) {
    logger.error('Failed to get hourly metrics', error);
    res.status(500).json(errorResponse('hourly_metrics_failed', error.message));
  }
});

/**
 * GET /api/v1/analytics/daily/:contractId/:metricType
 * Get daily metrics
 */
router.get('/daily/:contractId/:metricType', (req, res) => {
  try {
    const { contractId, metricType } = req.params;
    const { daysBack = 30 } = req.query;

    const metrics = analyticsEngine.getDailyMetrics(
      contractId,
      metricType,
      parseInt(daysBack, 10)
    );

    res.json({
      success: true,
      contractId,
      metricType,
      daysBack: parseInt(daysBack, 10),
      metrics,
      count: metrics.length,
    });
  } catch (error) {
    logger.error('Failed to get daily metrics', error);
    res.status(500).json(errorResponse('daily_metrics_failed', error.message));
  }
});

/**
 * POST /api/v1/analytics/record/hourly
 * Record hourly metric
 */
router.post('/record/hourly', (req, res) => {
  try {
    const { contractId, metricType, metricValue, metadata } = req.body;

    if (!contractId || !metricType || metricValue === undefined) {
      return res.status(400).json(
        errorResponse('validation_failed', 'contractId, metricType, and metricValue are required')
      );
    }

    analyticsEngine.recordHourlyMetric(contractId, metricType, metricValue, metadata || {});

    res.json({
      success: true,
      message: 'Hourly metric recorded',
    });
  } catch (error) {
    logger.error('Failed to record hourly metric', error);
    res.status(500).json(errorResponse('metric_recording_failed', error.message));
  }
});

/**
 * POST /api/v1/analytics/record/daily
 * Record daily metric
 */
router.post('/record/daily', (req, res) => {
  try {
    const { contractId, metricType, metricValue, metadata } = req.body;

    if (!contractId || !metricType || metricValue === undefined) {
      return res.status(400).json(
        errorResponse('validation_failed', 'contractId, metricType, and metricValue are required')
      );
    }

    analyticsEngine.recordDailyMetric(contractId, metricType, metricValue, metadata || {});

    res.json({
      success: true,
      message: 'Daily metric recorded',
    });
  } catch (error) {
    logger.error('Failed to record daily metric', error);
    res.status(500).json(errorResponse('metric_recording_failed', error.message));
  }
});

/**
 * POST /api/v1/analytics/record/event
 * Record real-time event
 */
router.post('/record/event', (req, res) => {
  try {
    const { eventType, contractId, eventData } = req.body;

    if (!eventType || !contractId || !eventData) {
      return res.status(400).json(
        errorResponse('validation_failed', 'eventType, contractId, and eventData are required')
      );
    }

    analyticsEngine.recordRealtimeEvent(eventType, contractId, eventData);

    res.json({
      success: true,
      message: 'Real-time event recorded',
    });
  } catch (error) {
    logger.error('Failed to record real-time event', error);
    res.status(500).json(errorResponse('event_recording_failed', error.message));
  }
});

/**
 * GET /api/v1/analytics/realtime/events
 * Get real-time events
 */
router.get('/realtime/events', (req, res) => {
  try {
    const { contractId, eventType, limit = 100 } = req.query;

    const events = analyticsEngine.getRealtimeEvents(
      contractId || null,
      eventType || null,
      parseInt(limit, 10)
    );

    res.json({
      success: true,
      events,
      count: events.length,
    });
  } catch (error) {
    logger.error('Failed to get real-time events', error);
    res.status(500).json(errorResponse('events_retrieval_failed', error.message));
  }
});

/**
 * POST /api/v1/analytics/cohort/add
 * Add user to cohort
 */
router.post('/cohort/add', (req, res) => {
  try {
    const { cohortDate, cohortType, userAddress, contractId, metadata } = req.body;

    if (!cohortDate || !cohortType || !userAddress || !contractId) {
      return res.status(400).json(
        errorResponse('validation_failed', 'cohortDate, cohortType, userAddress, and contractId are required')
      );
    }

    analyticsEngine.addToCohort(cohortDate, cohortType, userAddress, contractId, metadata || {});

    res.json({
      success: true,
      message: 'User added to cohort',
    });
  } catch (error) {
    logger.error('Failed to add user to cohort', error);
    res.status(500).json(errorResponse('cohort_add_failed', error.message));
  }
});

/**
 * GET /api/v1/analytics/cohort/analysis
 * Get cohort analysis
 */
router.get('/cohort/analysis', (req, res) => {
  try {
    const { cohortType, startDate, endDate } = req.query;

    if (!cohortType || !startDate || !endDate) {
      return res.status(400).json(
        errorResponse('validation_failed', 'cohortType, startDate, and endDate are required')
      );
    }

    const analysis = analyticsEngine.getCohortAnalysis(cohortType, startDate, endDate);

    res.json({
      success: true,
      cohortType,
      startDate,
      endDate,
      analysis,
      count: analysis.length,
    });
  } catch (error) {
    logger.error('Failed to get cohort analysis', error);
    res.status(500).json(errorResponse('cohort_analysis_failed', error.message));
  }
});

/**
 * GET /api/v1/analytics/anomalies
 * Get detected anomalies
 */
router.get('/anomalies', (req, res) => {
  try {
    const { contractId, severity, limit = 50 } = req.query;

    const anomalies = analyticsEngine.getAnomalies(
      contractId || null,
      severity || null,
      parseInt(limit, 10)
    );

    res.json({
      success: true,
      anomalies,
      count: anomalies.length,
    });
  } catch (error) {
    logger.error('Failed to get anomalies', error);
    res.status(500).json(errorResponse('anomalies_retrieval_failed', error.message));
  }
});

/**
 * GET /api/v1/analytics/trends
 * Get trends
 */
router.get('/trends', (req, res) => {
  try {
    const { contractId, metricType, limit = 50 } = req.query;

    const trends = analyticsEngine.getTrends(
      contractId || null,
      metricType || null,
      parseInt(limit, 10)
    );

    res.json({
      success: true,
      trends,
      count: trends.length,
    });
  } catch (error) {
    logger.error('Failed to get trends', error);
    res.status(500).json(errorResponse('trends_retrieval_failed', error.message));
  }
});

/**
 * POST /api/v1/analytics/aggregation/run
 * Manually trigger aggregation
 */
router.post('/aggregation/run', (req, res) => {
  try {
    analyticsEngine.runHourlyAggregation();

    res.json({
      success: true,
      message: 'Aggregation triggered successfully',
    });
  } catch (error) {
    logger.error('Failed to trigger aggregation', error);
    res.status(500).json(errorResponse('aggregation_failed', error.message));
  }
});

/**
 * POST /api/v1/analytics/experiments
 * Create an A/B testing experiment
 */
router.post('/experiments', (req, res) => {
  try {
    const { name, description, variants, trafficAllocation, metrics } = req.body;

    if (!name || !Array.isArray(variants) || variants.length < 2) {
      return res.status(400).json(
        errorResponse('validation_failed', 'name and at least two variants are required')
      );
    }

    const experiment = experimentTracker.createExperiment({
      name,
      description,
      variants,
      trafficAllocation,
      metrics,
    });

    res.status(201).json({
      success: true,
      experiment,
    });
  } catch (error) {
    logger.error('Failed to create experiment', error);
    res.status(500).json(errorResponse('experiment_creation_failed', error.message));
  }
});

/**
 * GET /api/v1/analytics/experiments
 * List experiments
 */
router.get('/experiments', (req, res) => {
  try {
    const { status } = req.query;

    const experiments = experimentTracker.listExperiments(status || null);

    res.json({
      success: true,
      experiments,
      count: experiments.length,
    });
  } catch (error) {
    logger.error('Failed to list experiments', error);
    res.status(500).json(errorResponse('experiments_retrieval_failed', error.message));
  }
});

/**
 * GET /api/v1/analytics/experiments/:experimentId
 * Get experiment details
 */
router.get('/experiments/:experimentId', (req, res) => {
  try {
    const { experimentId } = req.params;

    const experiment = experimentTracker.getExperiment(experimentId);

    if (!experiment) {
      return res.status(404).json(errorResponse('not_found', 'Experiment not found'));
    }

    res.json({
      success: true,
      experiment,
    });
  } catch (error) {
    logger.error('Failed to get experiment', error);
    res.status(500).json(errorResponse('experiment_retrieval_failed', error.message));
  }
});

/**
 * POST /api/v1/analytics/experiments/:experimentId/launch
 * Launch an experiment
 */
router.post('/experiments/:experimentId/launch', (req, res) => {
  try {
    const { experimentId } = req.params;

    const experiment = experimentTracker.launchExperiment(experimentId);

    res.json({
      success: true,
      experiment,
    });
  } catch (error) {
    logger.error('Failed to launch experiment', error);
    const status = error.code === 'not_found' ? 404 : 500;
    res.status(status).json(errorResponse(error.code || 'experiment_launch_failed', error.message));
  }
});

/**
 * POST /api/v1/analytics/experiments/:experimentId/assign
 * Assign a user to a variant (sticky)
 */
router.post('/experiments/:experimentId/assign', (req, res) => {
  try {
    const { experimentId } = req.params;
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json(
        errorResponse('validation_failed', 'userId is required')
      );
    }

    const assignment = experimentTracker.assignUser(experimentId, userId);

    res.json({
      success: true,
      assignment,
    });
  } catch (error) {
    logger.error('Failed to assign user to experiment', error);
    const status = error.code === 'not_found' ? 404 : 500;
    res.status(status).json(errorResponse(error.code || 'assignment_failed', error.message));
  }
});

/**
 * POST /api/v1/analytics/experiments/:experimentId/track
 * Track a metric for a user's variant
 */
router.post('/experiments/:experimentId/track', (req, res) => {
  try {
    const { experimentId } = req.params;
    const { userId, metricName, value } = req.body;

    if (!userId || !metricName || value === undefined) {
      return res.status(400).json(
        errorResponse('validation_failed', 'userId, metricName, and value are required')
      );
    }

    const result = experimentTracker.trackMetric(experimentId, userId, metricName, value);

    res.json({
      success: true,
      result,
    });
  } catch (error) {
    logger.error('Failed to track experiment metric', error);
    const status = error.code === 'not_found' ? 404 : 500;
    res.status(status).json(errorResponse(error.code || 'metric_tracking_failed', error.message));
  }
});

/**
 * GET /api/v1/analytics/experiments/:experimentId/results
 * Get experiment results with statistical significance
 */
router.get('/experiments/:experimentId/results', (req, res) => {
  try {
    const { experimentId } = req.params;

    const results = experimentTracker.getResults(experimentId);

    res.json({
      success: true,
      results,
    });
  } catch (error) {
    logger.error('Failed to get experiment results', error);
    const status = error.code === 'not_found' ? 404 : 500;
    res.status(status).json(errorResponse(error.code || 'results_retrieval_failed', error.message));
  }
});

/**
 * POST /api/v1/analytics/experiments/:experimentId/complete
 * Complete an experiment and determine winner
 */
router.post('/experiments/:experimentId/complete', (req, res) => {
  try {
    const { experimentId } = req.params;

    const result = experimentTracker.completeExperiment(experimentId);

    res.json({
      success: true,
      result,
    });
  } catch (error) {
    logger.error('Failed to complete experiment', error);
    const status = error.code === 'not_found' ? 404 : 500;
    res.status(status).json(errorResponse(error.code || 'experiment_completion_failed', error.message));
  }
});

/**
 * POST /api/v1/analytics/experiments/:experimentId/launch-winner
 * Launch the winning variant to all users
 */
router.post('/experiments/:experimentId/launch-winner', (req, res) => {
  try {
    const { experimentId } = req.params;
    const { variantId } = req.body || {};

    const result = experimentTracker.launchWinner(experimentId, variantId || null);

    res.json({
      success: true,
      result,
    });
  } catch (error) {
    logger.error('Failed to launch winner', error);
    const status = error.code === 'not_found' ? 404 : 500;
    res.status(status).json(errorResponse(error.code || 'winner_launch_failed', error.message));
  }
});

module.exports = router;
