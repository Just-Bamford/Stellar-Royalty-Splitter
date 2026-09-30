/**
 * Experiment Tracker Service
 *
 * Manages A/B test experiments, sticky user assignment, metric tracking,
 * statistical significance calculation, and winner determination.
 */

const crypto = require('crypto');

const STATUSES = ['draft', 'running', 'paused', 'completed'];

function normalCcdf(x) {
  // Approximation of the standard normal CDF based on the Zelen & Severo polynomial.
  const b = [0.319381530, -0.3565637, 0.781481937, 1.330274429];
  const c = [0.2316419, 0.367466, 0.14589485];
  const t = 1 / (1 + b[0] * Math.abs(x));
  const poly = t * (c[0] + t * (c[1] + t * c[2]));
  const exp = 1 - Math.exp(-(Math.max(x) * x) / 2) * (1 / Math.sqrt(2 * Math.PI) * (b[0] + poly));
  return x >= 0 ? exp : 1 - exp;
}

function hashString(value) {
  return crypto.createHash('sha256').update(value);
}

function bucketFor(experimentId, userId) {
  const digest = crypto.createHash('sha256').update(`${experimentId}::${userId}`).digest();
  const num = digest.readUInt32BE(0);
  return num % 10000;
}

function validateVariants(variants) {
  if (!Array.isArray(variants) || variants.length < 2) {
    throw new Error('At least two variants are required');
  }
  const total = variants.reduce((sum, v) => sum + Number(v.weight ?? 0), 0);
  if (Math.abs(total - 100) > 0.001) {
    throw new Error('Variant weights must sum to 100');
  }
  const ids = new Set();
  for (const v of variants) {
    if (!v.id || !v.name) {
      throw new Error('Each variant must have an id and name');
    }
    if (ids.has(v.id)) {
      throw new Error(`Duplicate variant id ${v.id}`);
    }
    ids.add(v.id);
  }
}

class ExperimentTracker {
  constructor() {
    this.experiments = new Map();
    this.assignments = new Map();
    this.events = [];
  }

  createExperiment(input) {
    if (!input || !input.name || !input.featureKey) {
      throw new Error('name and featureKey are required');
    }
    validateVariants(input.variants);
    const now = Date.now();
    const id = `exp_${now}_${crypto.randomBytes(4).toString('hex')}`;
    const variants = input.variants.map((v, idx) => ({
      id: v.id,
      name: v.name,
      weight: Number(v.weight),
      isControl: Boolean(v.isControl ?? idx === 0),
      description: v.description,
    }));
    const experiment = {
      id,
      name: input.name,
      description: input.description,
      featureKey: input.featureKey,
      status: 'draft',
      variants,
      metrics: Array.isArray(input.metrics) ? input.metrics : [],
      targetSampleSize: input.targetSampleSize,
      createdAt: now,
      updatedAt: now,
    };
    this.experiments.set(id, experiment);
    return experiment;
  }

  getExperiment(id) {
    return this.experiments.get(id);
  }

  listExperiments(status = null) {
    const all = Array.from(this.experiments.values());
    if (!status) return all;
    return all.filter((exp) => exp.status === status);
  }

  requireExperiment(id) {
    const exp = this.experiments.get(id);
    if (!exp) {
      const error = new Error(`Experiment ${id} not found`);
      error.code = 'not_found';
      throw error;
    }
    return exp;
  }

  launchExperiment(id) {
    const exp = this.requireExperiment(id);
    exp.status = 'running';
    exp.startedAt = exp.startedAt ?? Date.now();
    exp.updatedAt = Date.now();
    return exp;
  }

  pauseExperiment(id) {
    const exp = this.requireExperiment(id);
    exp.status = 'paused';
    exp.updatedAt = Date.now();
    return exp;
  }

  completeExperiment(id) {
    const exp = this.requireExperiment(id);
    exp.status = 'completed';
    exp.updatedAt = Date.now();
    return exp;
  }

  assignVariant(experimentId, userId) {
    if (!userId) {
      throw new Error('userId is required');
    }
    const cacheKey = `${experimentId}:${userId}`;
    const existing = this.assignments.get(cacheKey);
    if (existing) {
      return existing.variantId;
    }
    const exp = this.requireExperiment(experimentId);
    const bucket = bucketFor(experimentId, userId);
    const normalized = (bucket / 10000) * 100;
    let cumulative = 0;
    let selected = exp.variants[exp.variants.length - 1];
    for (const variant of exp.variants) {
      cumulative += variant.weight;
      if (normalized < cumulative) {
        selected = variant;
        break;
      }
    }
    const record = {
      experimentId,
      userId,
      variantId: selected.id,
      assignedAt: Date.now(),
    };
    this.assignments.set(cacheKey, record);
    return selected.id;
  }

  assignUser(experimentId, userId) {
    const variantId = this.assignVariant(experimentId, userId);
    return {
      experimentId,
      userId,
      variantId,
    };
  }

  getVariantForUser(experimentId, userId) {
    const exp = this.requireExperiment(experimentId);
    const vid = this.assignVariant(experimentId, userId);
    const variant = exp.variants.find((v) => v.id === vid);
    if (!variant) {
      throw new Error(`Assigned variant ${vid} not found`);
    }
    return variant;
  }

  trackEvent(experimentId, userId, metricName, value = 1) {
    const variantId = this.assignVariant(experimentId, userId);
    const event = {
      experimentId,
      userId,
      variantId,
      metricName,
      value: Number(value),
      timestamp: Date.now(),
    };
    this.events.push(event);
    return event;
  }

  trackConversion(experimentId, userId, revenue = 0) {
    const event = this.trackEvent(experimentId, userId, 'conversion', 1);
    if (revenue > 0) {
      this.trackEvent(experimentId, userId, 'revenue', revenue);
    }
    return event;
  }

  trackEngagement(experimentId, userId, score) {
    return this.trackEvent(experimentId, userId, 'engagement', score);
  }

  computeVariantStats(experimentId) {
    const exp = this.requireExperiment(experimentId);
    const exposures = new Map();
    const conversions = new Map();
    const revenue = new Map();
    const engagement = new Map();
    for (const v of exp.variants) {
      exposures.set(v.id, new Set());
      conversions.set(v.id, new Set());
      revenue.set(v.id, 0);
      engagement.set(v.id, { total: 0, count: 0 });
    }
    for (const assignment of this.assignments.values()) {
      if (assignment.experimentId !== experimentId) continue;
      exposures.get(assignment.variantId)?.add(assignment.userId);
    }
    for (const event of this.events) {
      if (event.experimentId !== experimentId) continue;
      exposures.get(event.variantId)?.add(event.userId);
      if (event.metricName === 'conversion') {
        conversions.get(event.variantId)?.add(event.userId);
      } else if (event.metricName === 'revenue') {
        revenue.set(event.variantId, (revenue.get(event.variantId) ?? 0) + event.value);
      } else if (event.metricName === 'engagement') {
        const cur = engagement.get(event.variantId) ?? { total: 0, count: 0 };
        cur.total += event.value;
        cur.count += 1;
        engagement.set(event.variantId, cur);
      }
    }
    return exp.variants.map((variant) => {
      const exposureCount = exposures.get(variant.id)?.size ?? 0;
      const conversionCount = conversions.get(variant.id)?.size ?? 0;
      const conversionRate = exposureCount > 0 ? conversionCount / exposureCount : 0;
      const se = exposureCount > 0
        ? Math.sqrt((conversionRate * (1 - conversionRate)) / exposureCount)
        : 0;
      const margin = 1.96 * se;
      const engagementStat = engagement.get(variant.id) ?? { total: 0, count: 0 };
      const totalRevenue = revenue.get(variant.id) ?? 0;
      return {
        variantId: variant.id,
        exposures: exposureCount,
        conversions: conversionCount,
        conversionRate,
        totalRevenue: totalRevenue,
        avgEngagement: engagementStat.count > 0 ? engagementStat.total / engagementStat.count : 0,
        revenuePerUser: exposureCount > 0 ? totalRevenue / exposureCount : 0,
        standardError: se,
        confidenceInterval: [Math.max(0, conversionRate - margin), Math.min(1, conversionRate + margin)],
      };
    });
  }

  calculateSignificance(experimentId) {
    const exp = this.requireExperiment(experimentId);
    const stats = this.computeVariantStats(experimentId);
    const control = exp.variants.find((v) => v.isControl) ?? exp.variants[0];
    const controlStats = stats.find((s) => s.variantId === control.id);
    if (!controlStats) return [];
    const results = [];
    for (const stat of stats) {
      if (stat.variantId === control.id) continue;
      const p1 = controlStats.conversionRate;
      const p2 = stat.conversionRate;
      const n1 = controlStats.exposures;
      const n2 = stat.exposures;
      if (n1 === 0 || n2 === 0) {
        results.push({
          controlVariantId: control.id,
          treatmentVariantId: stat.variantId,
          zScore: 0,
          pValue: 1,
          significant: false,
          lift: 0,
          confidenceLevel: 0,
        });
        continue;
      }
      const pooled = (controlStats.conversions + stat.conversions) / (n1 + n2);
      const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
      const zScore = se > 0 ? (p2 - p1) / se : 0;
      const pValue = 2 * (1 - normalCcdf(Math.abs(zScore)));
      const lift = p1 > 0 ? (p2 - p1) / p1 : 0;
      const confidenceLevel = 1 - pValue;
      results.push({
        controlVariantId: control.id,
        treatmentVariantId: stat.variantId,
        zScore,
        pValue,
        significant: pValue < 0.05,
        lift,
        confidenceLevel,
      });
    }
    return results;
  }

  getExperimentResults(experimentId) {
    const exp = this.requireExperiment(experimentId);
    const variantStats = this.computeVariantStats(experimentId);
    const significance = this.calculateSignificance(experimentId);
    const control = exp.variants.find((v) => v.isControl) ?? exp.variants[0];
    const controlStats = variantStats.find((s) => s.variantId === control.id);
    const controlRate = controlStats ? controlStats.conversionRate : 0;

    const candidates = variantStats
      .filter((s) => s.variantId !== control.id)
      .map((s) => {
        const sig = significance.find((r) => r.treatmentVariantId === s.variantId);
        return {
          stat: s,
          significance: sig,
          lift: sig ? sig.lift : 0,
        };
      })
      .filter((c) => c.significance && c.significance.significant && c.lift > 0)
      .sort((a, b) => b.lift - a.lift);

    const winnerId = candidates.length > 0 ? candidates[0].stat.variantId : null;
    const totalExposures = variantStats.reduce((sum, s) => sum + s.exposures, 0);

    let recommendation;
    if (!winnerId) {
      recommendation = 'No statistically significant winner yet. Keep the experiment running.';
    } else {
      const winnerStat = variantStats.find((s) => s.variantId === winnerId);
      const lift = controlRate > 0 ? ((winnerStat.conversionRate - controlRate) / controlRate) * 100 : 0;
      recommendation = `Variant ${winnerId} is the winner with a ${lift.toFixed(2)}% lift over control.`;
    }

    return {
      experimentId,
      variantStats,
      significance,
      winnerId,
      recommendation,
      totalExposures,
    };
  }

  launchWinner(experimentId) {
    const results = this.getExperimentResults(experimentId);
    if (!results.winnerId) {
      throw new Error('No statistically significant winner to launch');
    }
    const exp = this.requireExperiment(experimentId);
    exp.winnerId = results.winnerId;
    exp.status = 'completed';
    exp.updatedAt = Date.now();
    return exp;
  }
}

const tracker = new ExperimentTracker();

module.exports = tracker;
module.exports.ExperimentTracker = ExperimentTracker;
module.exports.STATUSES = STATUSES;