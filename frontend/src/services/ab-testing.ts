/**
 * A/B Testing Service
 *
 * Provides experiment creation, sticky variant assignment,
 * metric tracking, statistical significance calculation, and winner
 * determination for feature flags.
 */

export type ExperimentStatus = "draft" | "running" | "paused" | "completed";

export interface Variant {
  id: string;
  name: string;
  weight: number; // 0-100 traffic percentage
  isControl: boolean;
  description?: string;
}

export interface ExperimentMetric {
  name: string;
  type: "conversion" | "engagement" | "revenue";
  goal?: "higher" | "lower";
}

export interface Experiment {
  id: string;
  name: string;
  description?: string;
  featureKey: string;
  status: ExperimentStatus;
  variants: Variant[];
  metrics: ExperimentMetric[];
  targetSampleSize?: number;
  startedAt?: number;
  createdAt: number;
  updatedAt: number;
  winnerId?: string;
}

export interface VariantStats {
  variantId: string;
  exposures: number;
  conversions: number;
  conversionRate: number;
  totalRevenue: number;
  avgEngagement: number;
  revenuePerUser: number;
  standardError: number;
  confidenceInterval: [number, number];
}

export interface SignificanceResult {
  controlVariantId: string;
  treatmentVariantId: string;
  zScore: number;
  pValue: number;
  significant: boolean;
  lift: number;
  confidenceLevel: number;
}

export interface ExperimentResult {
  experimentId: string;
  variantStats: VariantStats[];
  significance: SignificanceResult[];
  winnerId: string | null;
  recommendation: string;
  totalExposures: number;
}

export interface AssignmentRecord {
  experimentId: string;
  userId: string;
  variantId: string;
  assignedAt: number;
}

export interface EventRecord {
  experimentId: string;
  userId: string;
  variantId: string;
  metricName: string;
  value: number;
  timestamp: number;
}

export interface ABTestingConfig {
  apiBaseUrl?: string;
  storageKey?: string;
  fetchImpl?: typeof fetch;
}

const DEFAULT_STORAGE_KEY = "ab-testing-assignments";

function hashString(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul((hash << 5) - hash + hash, 1) >> 2;
  }
  return hash >>> 0;
}

function normalCcdf(x: number): number {
  // Approximation of the standard normal CDF based on the Zelen & Severo polynomial.
  const b = [0.31938153, -0.3565637, 0.781481937, 1.330274429];
  const c = [0.2316419, 0.367466, 0.14589485];
  const t = 1 / (1 + b[0] * Math.abs(x));
  const poly = t * (c[0] + t * (c[1] + t * c[2]));
  const exp = 1 - Math.exp(-(x * x) / 2) * (1 / Math.sqrt(2 * Math.PI)) * (b[0] + poly);
  return x >= 0 ? exp : 1 - exp;
}

export class ABTestingService {
  private experiments: Map<string, Experiment> = new Map();
  private assignments: Map<string, AssignmentRecord> = new Map();
  private events: EventRecord[] = [];
  private config: Required<ABTestingConfig>;
  private fetchImpl: typeof fetch;

  constructor(config: ABTestingConfig = {}) {
    this.config = {
      apiBaseUrl: config.apiBaseUrl ?? "",
      storageKey: config.storageKey ?? DEFAULT_STORAGE_KEY,
      fetchImpl: config.fetchImpl,
    } as Required<ABTestingConfig>;
    this.fetchImpl =
      config.fetchImpl ??
      (typeof fetch !== "undefined"
        ? fetch.bind(globalThis)
        : async () => {
            throw new Error("No fetch implementation available");
          });
    this.loadAssignments();
  }

  /** Create a new experiment. */
  createExperiment(input: {
    name: string;
    description?: string;
    featureKey: string;
    variants: Array<Omit<Variant, "id"> & { id?: string }>;
    metrics: ExperimentMetric[];
    targetSampleSize?: number;
  }): Experiment {
    if (!input.name || !input.featureKey) {
      throw new Error("name and featureKey are required");
    }
    if (!input.variants || input.variants.length < 2) {
      throw new Error("At least two variants are required");
    }
    const totalWeight = input.variants.reduce((sum, vI) => sum + vI.weight, 0);
    if (Math.abs(totalWeight - 100) > 0.001) {
      throw new Error("Variant weights must sum to 100");
    }

    const now = Date.now();
    const id = `exp_${now}_${Math.random().toString(36).slice(2, 8)}`;
    const variants: Variant[] = input.variants.map((vI, idx) => ({
      id: vI.id ?? `variant_${idx}`,
      name: vI.name,
      weight: vI.weight,
      isControl: vI.isControl ?? idx === 0,
      description: vI.description,
    }));

    const experiment: Experiment = {
      id,
      name: input.name,
      description: input.description,
      featureKey: input.featureKey,
      status: "draft",
      variants,
      metrics: input.metrics,
      targetSampleSize: input.targetSampleSize,
      createdAt: now,
      updatedAt: now,
    };
    this.experiments.set(id, experiment);
    return experiment;
  }

  /** Launch an experiment (start routing users). */
  launchExperiment(experimentId: string): Experiment {
    const exp = this.requireExperiment(experimentId);
    exp.status = "running";
    exp.startedAt = exp.startedAt ?? Date.now();
    exp.updatedAt = Date.now();
    return exp;
  }

  /** Pause a running experiment. */
  pauseExperiment(experimentId: string): Experiment {
    const exp = this.requireExperiment(experimentId);
    exp.status = "paused";
    exp.updatedAt = Date.now();
    return exp;
  }

  /** Complete an experiment and freeze results. */
  completeExperiment(experimentId: string): Experiment {
    const exp = this.requireExperiment(experimentId);
    exp.status = "completed";
    exp.updatedAt = Date.now();
    return exp;
  }

  /** Get an experiment by id. */
  getExperiment(experimentId: string): Experiment | undefined {
    return this.experiments.get(experimentId);
  }

  /** List all experiments. */
  listExperiments(): Experiment[] {
    return Array.from(this.experiments.values());
  }

  /**
   * Stickly assign a user to a variant for an experiment.
   * The assignment is deterministic given (experimentId, userId) and is cached.
   */
  assignVariant(experimentId: string, userId: string): string {
    if (!userId) {
      throw new Error("userId is required");
    }
    const cacheKey = `${experimentId}:${userId}`;
    const existing = this.assignments.get(cacheKey);
    if (existing) {
      return existing.variantId;
    }

    const exp = this.requireExperiment(experimentId);
    const hash = hashString(`${experimentId}::${userId}`);
    const bucket = hash % 10000;
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

    const record: AssignmentRecord = {
      experimentId,
      userId,
      variantId: selected.id,
      assignedAt: Date.now(),
    };
    this.assignments.set(cacheKey, record);
    this.persistAssignments();
    return selected.id;
  }

  /** Return the variant configuration for a user. */
  getVariantForUser(experimentId: string, userId: string): Variant {
    const exp = this.requireExperiment(experimentId);
    const vid = this.assignVariant(experimentId, userId);
    const variant = exp.variants.find((v) => v.id === vid);
    if (!variant) {
      throw new Error(`Assigned variant ${vid} not found`);
    }
    return variant;
  }

  /** Record a metric event for a user. */
  trackEvent(experimentId: string, userId: string, metricName: string, value = 1): EventRecord {
    const variantId = this.assignVariant(experimentId, userId);
    const event: EventRecord = {
      experimentId,
      userId,
      variantId,
      metricName,
      value,
      timestamp: Date.now(),
    };
    this.events.push(event);
    return event;
  }

  /** Record a conversion for a user. */
  trackConversion(experimentId: string, userId: string, revenue = 0): EventRecord {
    const event = this.trackEvent(experimentId, userId, "conversion", 1);
    if (revenue > 0) {
      this.trackEvent(experimentId, userId, "revenue", revenue);
    }
    return event;
  }

  /** Record an engagement score for a user. */
  trackEngagement(experimentId: string, userId: string, score: number): EventRecord {
    return this.trackEvent(experimentId, userId, "engagement", score);
  }

  /** Compute per-variant statistics. */
  computeVariantStats(experimentId: string): VariantStats[] {
    const exp = this.requireExperiment(experimentId);
    const exposures = new Map<string, Set<string>>();
    const conversions = new Map<string, Set<string>>();
    const revenue = new Map<string, number>();
    const engagement = new Map<string, { total: number; count: number }>();

    for (const variant of exp.variants) {
      exposures.set(variant.id, new Set());
      conversions.set(variant.id, new Set());
      revenue.set(variant.id, 0);
      engagement.set(variant.id, { total: 0, count: 0 });
    }

    for (const assignment of this.assignments.values()) {
      if (assignment.experimentId !== experimentId) continue;
      exposures.get(assignment.variantId)?.add(assignment.userId);
    }

    for (const event of this.events) {
      if (event.experimentId !== experimentId) continue;
      exposures.get(event.variantId)?.add(event.userId);
      if (event.metricName === "conversion") {
        conversions.get(event.variantId)?.add(event.userId);
      } else if (event.metricName === "revenue") {
        revenue.set(event.variantId, (revenue.get(event.variantId) ?? 0) + event.value);
      } else if (event.metricName === "engagement") {
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
      const se =
        exposureCount > 0 ? Math.sqrt((conversionRate * (1 - conversionRate)) / exposureCount) : 0;
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
        confidenceInterval: [
          Math.max(0, conversionRate - margin),
          Math.min(1, conversionRate + margin),
        ],
      };
    });
  }

  /** Calculate statistical significance between control and treatments. */
  calculateSignificance(experimentId: string): SignificanceResult[] {
    const exp = this.requireExperiment(experimentId);
    const stats = this.computeVariantStats(experimentId);
    const control = exp.variants.find((v) => v.isControl) ?? exp.variants[0];
    const controlStats = stats.find((s) => s.variantId === control.id);
    if (!controlStats) {
      return [];
    }

    const results: SignificanceResult[] = [];
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

  /** Determine the winning variant based on metrics and significance. */
  determineWinner(experimentId: string): ExperimentResult {
    const exp = this.requireExperiment(experimentId);
    const stats = this.computeVariantStats(experimentId);
    const significance = this.calculateSignificance(experimentId);
    const totalExposures = stats.reduce((sum, s) => sum + s.exposures, 0);

    const metric = exp.metrics.find((m) => m.type === "conversion") ?? exp.metrics[0];
    const higherIsBetter = (metric?.goal ?? "higher") === "higher";

    const score = (s) => {
      if (!metric) return s.conversionRate;
      if (metric.type === "revenue") return s.revenuePerUser;
      if (metric.type === "engagement") return s.avgEngagement;
      return s.conversionRate;
    };

    const control = exp.variants.find((v) => v.isControl) ?? exp.variants[0];
    const controlStats = stats.find((s) => s.variantId === control.id);
    const controlScore = controlStats ? score(controlStats) : 0;

    let winnerId: string | null = null;
    let bestScore = controlScore;
    for (const stat of stats) {
      if (stat.variantId === control.id) continue;
      const score = score(stat);
      const sig = significance.find((s) => s.treatmentVariantId === stat.variantId);
      const isBetter = higherIsBetter ? score > bestScore : score < bestScore;
      if (sig?.significant && isBetter) {
        bestScore = score;
        winnerId = stat.variantId;
      }
    }

    let recommendation: string;
    if (winnerId) {
      const winner = exp.variants.find((v) => v.id === winnerId);
      recommendation = `Variant "${winner?.name ?? winnerId}" is the winner with statistical significance.`;
    } else if (totalExposures === 0) {
      recommendation = "No exposures yet. Launch the experiment to collect data.";
    } else {
      recommendation = "No statistically significant winner yet. Continue collecting data.";
    }

    return {
      experimentId,
      variantStats: stats,
      significance,
      winnerId,
      recommendation,
      totalExposures,
    };
  }

  /** Launch the winning variant to all users. */
  launchWinner(experimentId: string): Experiment {
    const result = this.determineWinner(experimentId);
    if (!result.winnerId) {
      throw new Error("No statistically significant winner to launch");
    }
    const exp = this.requireExperiment(experimentId);
    exp.winnerId = result.winnerId;
    exp.status = "completed";
    exp.updatedAt = Date.now();
    return exp;
  }

  /** Get the current results for an experiment. */
  getResults(experimentId: string): ExperimentResult {
    return this.determineWinner(experimentId);
  }

  /** Return all events for an experiment. */
  getEvents(experimentId: string): EventRecord {
    return this.events.filter((e) => e.experimentId === experimentId);
  }

  /** Return all assignments for an experiment. */
  getAssignments(experimentId: string): AssignmentRecord[] {
    return Array.from(this.assignments.values()).filter((a) => a.experimentId === experimentId);
  }

  /** Persist assignments to local storage when available. */
  private persistAssignments(): void {
    if (typeof globalThis === "undefined") return;
    const storage = (globalThis as any).localStorage;
    if (!storage) return;
    try {
      const payload = Array.from(this.assignments.values());
      storage.setItem(this.config.storageKey, JSON.stringify(payload));
    } catch {
      // ignore storage errors
    }
  }

  /** Load persisted assignments from local storage. */
  private loadAssignments(): void {
    if (typeof globalThis === "undefined") return;
    const storage = (globalThis as any).localStorage;
    if (!storage) return;
    try {
      const raw = storage.getItem(this.config.storageKey);
      if (!raw) return;
      const parsed = JSON.parse(raw) as AssignmentRecord[];
      for (const record of parsed) {
        this.assignments.set(`${record.experimentId}:${record.userId}`, record);
      }
    } catch {
      // ignore storage errors
    }
  }

  /** Ensure an experiment exists. */
  private requireExperiment(experimentId: string): Experiment {
    const exp = this.experiments.get(experimentId);
    if (!exp) {
      throw new Error(`Experiment ${experimentId} not found`);
    }
    return exp;
  }
}

export default ABTestingService;
