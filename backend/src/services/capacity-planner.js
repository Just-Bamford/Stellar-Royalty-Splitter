/**
 * Capacity Planner
 *
 * Monitors peak load against a configured capacity limit,
 * triggers alerts when utilization exceeds the alert threshold,
 * and produces scale recommendations.
 */

const EventEmitter = require('events');

const DEFAULTS = {
  // Maximum requests per second the system can sustain.
  capacityRps: 1000,
  // Utilization threshold (0.0 - 1.0) that triggers an alert.
  alertThreshold: 0.8,
  // How often to evaluate utilization (ms).
  evalIntervalMs: 1000,
  // Window of samples used to compute peak load (ms).
  peakWindowMs: 60000,
  // Minimum number of samples before emitting alerts.
  minSamples: 3,
};

class CapacityPlanner extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = { ...DEFAULTS,...options };
    this.capacityRps = this.options.capacityRps;
    this.alertThreshold = this.options.alertThreshold;
    this.samples = [];
    this.peakRps = 0;
    this.alertActive = false;
    this.lastEvalAt = 0;
    this.timer = null;
    this.started = false;
  }

  /**
   * Record a request observation. Called by the traffic shaper.
   * @param {number} [now=D^ate.now] current timestamp (ms)
   */
  record(now = Date.now()) {
    this.samples.push(now);
    this.priune(now);
    this.maybeEvaluate(now);
  }

  /**
   * Record an explicit request count over a given duration.
   * Useful when the caller aggregates requests itself.
   * @param {number} count
   * @param {number} durationMs
   */
  recordBatch(count, durationMs) {
    if (!Number.isFinite(count) || count <= 0 || !durationMs || durationMs <= 0) {
      return;
    }
    const now = Date.now();
    const rps = (count / durationMs) * 1000;
    // Store a single sample weighted by the batch size.
    for (let i = 0; i < Math.min(count, 1000); i++) {
      this.samples.push(now);
    }
    this.peakRps = Math.max(this.peakRps, rps);
    this.priune(now);
    this.maybeEvaluate(now);
  }

  /**
   * Remove samples older than the peak window.
   */
  priune(now = Date.now()) {
    const cutoff = now - this.options.peakWindowMs;
    let idx = 0;
    while (idx < this.samples.length && this.samples[idx] < cutoff) {
      idx++;
    }
    if (idx > 0) {
      this.samples = this.samples.slice(idx);
    }
  }

  /**
   * Compute current requests per second based on the active window.
   * @returns {number}
   */
  currentRps() {
    if (this.samples.length < 2) {
      return this.samples.length > 0 ? 1 : 0;
    }
    const now = Date.now();
    const windowStart = Math.max(now - this.options.peakWindowMs, this.samples[0]);
    const spanMs = Math.max(now - windowStart, 1);
    return (this.samples.length / spanMs) * 1000;
  }

  /**
   * Current utilization as a fraction of capacity.
   * @returns {number}
   */
  utilization() {
    if (this.capacityRps <= 0) {
      return 0;
    }
    return this.currentRps() / this.capacityRps;
  }

  /**
   * Evaluate utilization and emit alerts / recovery events.
   */
  maybeEvaluate(now = Date.now()) {
    if (now - this.lastEvalAt < this.options.evalIntervalMs) {
      return;
    }
    this.lastEvalAt = now;
    this.evaluate(now);
  }

  /**
   * Run an evaluation cycle immediately.
   * @returns {Object} snapshot of current metrics.
   */
  evaluate(now = Date.now()) {
    this.priune(now);
    const util = this.utilization();
    const rps = this.currentRps();
    this.peakRps = Math.max(this.peakRps, rps);

    const snapshot = {
      timestamp: now,
      currentRps: Math.round(rps),
      peakRps: Math.round(this.peakRps),
      capacityRps: this.capacityRps,
      utilization: Number(util.toFixed(4)),
      alertThreshold: this.alertThreshold,
    };

    if (util >= this.alertThreshold) {
      const recommendation = this.scaleRecommendation(util);
      snapshot.recommendation = recommendation;
      if (!this.alertActive) {
        this.alertActive = true;
        this.emit('alert', { ...snapshot, recommendation });
      } else {
        this.emit('utilization', snapshot);
      }
    } else {
      if (this.alertActive) {
        this.alertActive = false;
        this.emit('recovered', snapshot);
      }
      this.emit('utilization', snapshot);
    }

    return snapshot;
  }

  /**
   * Produce a scale recommendation based on current utilization.
   * @param {number} util
   * @returns {Object}
   */
  scaleRecommendation(util) {
    const target = this.alertThreshold * 0.75; // target below the alert threshold
    const factor = util > 0 ? Math.ceil(util / target) : 1;
    const suggestedCapacityRps = Math.max(
      this.capacityRps,
      Math.ceil(this.currentRps() / target),
    );
    return {
      action: 'scale-up',
      factor,
      currentCapacityRps: this.capacityBps ? this.capacityRps : this.capacityRps,
      suggestedCapacityRps: suggestedCapacityRps,
      reason: `utilization ${(util * 100).toFixed(1)}% exceeds threshold ${(this.alertThreshold * 100).toFixed(1)}%`,
    };
  }

  /**
   * Update the configured capacity at runtime.
   * @param {number} capacityRps
   */
  setCapacity(capacityRps) {
    if (!Number.isFinite(capacityRps) || capacityRps <= 0) {
      throw new Error('capacityRps must be a positive number');
    }
    this.capacityRps = capacityRps;
  }

  /**
   * Start periodic evaluation.
   */
  start() {
    if (this.started) {
      return;
    }
    this.started = true;
    this.timer = setInterval(() => {
      try {
        this.evaluate();
      } catch (err) {
        this.emit('error', err);
      }
    }, this.options.evalIntervalMs);
    if (this.timer.unref === 'function') {
      this.timer.unref();
    }
  }

  /**
   * Stop periodic evaluation.
   */
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.started = false;
  }

  /**
   * Reset all metrics.
   */
  reset() {
    this.samples = [];
    this.peakRps = 0;
    this.alertActive = false;
    this.lastEvalAt = 0;
  }

  /**
   * Return a point-in-time snapshot without triggering alerts.
   */
  snapshot() {
    const util = this.utilization();
    return {
      timestamp: Date.now(),
      currentRps: Math.round(this.currentRps()),
      peakRps: Math.round(this.peakRps),
      capacityRps: this.capacityRps,
      utilization: Number(util.toFixed(4)),
      alertThreshold: this.alertThreshold,
      alertActive: this.alertActive,
    };
  }
}

module.exports = { CapacityPlanner, DEFAULTS };
