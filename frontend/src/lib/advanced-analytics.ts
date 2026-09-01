export interface DailyPoint {
  date: string;
  amount: number;
}

export interface HourlyPoint {
  hour: number;
  label: string;
  amount: number;
  count: number;
}

export interface TrendPoint {
  date: string;
  amount: number;
  movingAverage: number;
}

export interface ForecastPoint {
  date: string;
  forecastedAmount: number;
  lowerBound: number;
  upperBound: number;
}

export interface AnomalyPoint {
  date: string;
  amount: number;
  zScore: number;
  isAnomaly: boolean;
  type: "spike" | "dip" | "normal";
}

export interface HeatmapCell {
  date: string;
  actual: number;
  expected: number;
  variancePct: number;
  status: "green" | "yellow" | "red";
}

export interface PayoutRecord {
  timestamp: string;
  amount: number | string;
  id?: string | number;
  type?: string;
  details?: string;
}

/**
 * Calculates a rolling moving average for daily time series data.
 * @param data Array of daily points sorted by date ascending
 * @param windowSize Number of days for trailing window (default 7)
 */
export function calculateMovingAverage(
  data: DailyPoint[],
  windowSize = 7,
): TrendPoint[] {
  if (data.length === 0) return [];
  const result: TrendPoint[] = [];

  for (let i = 0; i < data.length; i++) {
    const windowStart = Math.max(0, i - windowSize + 1);
    const window = data.slice(windowStart, i + 1);
    const sum = window.reduce((acc, curr) => acc + curr.amount, 0);
    const avg = Number((sum / window.length).toFixed(2));
    result.push({
      date: data[i].date,
      amount: data[i].amount,
      movingAverage: avg,
    });
  }

  return result;
}

/**
 * Fits a linear regression model on historical daily points and extrapolates
 * future earnings with a standard error confidence interval (default 95%).
 */
export function calculateLinearForecast(
  data: DailyPoint[],
  forecastDays = 14,
  confidenceLevel = 0.95,
): ForecastPoint[] {
  if (data.length === 0) return [];

  const n = data.length;
  // If only 1 data point or all amounts are equal, return flat forecast
  if (n === 1) {
    const baseVal = data[0].amount;
    const startDate = new Date(`${data[0].date}T00:00:00.000Z`);
    const forecast: ForecastPoint[] = [];
    for (let k = 1; k <= forecastDays; k++) {
      const futureDate = new Date(startDate.getTime() + k * 86400000);
      const dateStr = futureDate.toISOString().slice(0, 10);
      const margin = Number((baseVal * 0.1).toFixed(2));
      forecast.push({
        date: dateStr,
        forecastedAmount: Number(baseVal.toFixed(2)),
        lowerBound: Number(Math.max(0, baseVal - margin).toFixed(2)),
        upperBound: Number((baseVal + margin).toFixed(2)),
      });
    }
    return forecast;
  }

  // Calculate linear regression slope (m) and intercept (b)
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;

  for (let i = 0; i < n; i++) {
    const x = i;
    const y = data[i].amount;
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumXX += x * x;
  }

  const meanX = sumX / n;
  const meanY = sumY / n;
  const denominator = sumXX - n * meanX * meanX;

  const slope = denominator === 0 ? 0 : (sumXY - n * meanX * meanY) / denominator;
  const intercept = meanY - slope * meanX;

  // Calculate standard error of estimate
  let sumSquaredResiduals = 0;
  for (let i = 0; i < n; i++) {
    const predictedY = slope * i + intercept;
    const residual = data[i].amount - predictedY;
    sumSquaredResiduals += residual * residual;
  }

  const degreesOfFreedom = Math.max(1, n - 2);
  const stdError = Math.sqrt(sumSquaredResiduals / degreesOfFreedom);

  // Z-score multiplier (approx 1.96 for 95%, 1.645 for 90%)
  const z = confidenceLevel >= 0.95 ? 1.96 : 1.645;

  const lastDate = new Date(`${data[n - 1].date}T00:00:00.000Z`);
  const forecast: ForecastPoint[] = [];

  for (let k = 1; k <= forecastDays; k++) {
    const futureX = n - 1 + k;
    const futureDate = new Date(lastDate.getTime() + k * 86400000);
    const dateStr = futureDate.toISOString().slice(0, 10);

    const projectedY = Math.max(0, slope * futureX + intercept);

    // Confidence interval margin calculation
    const distanceTerm = (futureX - meanX) ** 2 / (sumXX - n * meanX * meanX || 1);
    const margin = z * stdError * Math.sqrt(1 + 1 / n + distanceTerm);

    const lowerBound = Number(Math.max(0, projectedY - margin).toFixed(2));
    const upperBound = Number((projectedY + margin).toFixed(2));

    forecast.push({
      date: dateStr,
      forecastedAmount: Number(projectedY.toFixed(2)),
      lowerBound,
      upperBound,
    });
  }

  return forecast;
}

/**
 * Detects statistical anomalies (spikes/dips) in daily earnings using Z-Score.
 */
export function detectAnomalies(
  data: DailyPoint[],
  zThreshold = 2.0,
): AnomalyPoint[] {
  if (data.length < 3) {
    return data.map((d) => ({
      date: d.date,
      amount: d.amount,
      zScore: 0,
      isAnomaly: false,
      type: "normal",
    }));
  }

  const mean = data.reduce((acc, curr) => acc + curr.amount, 0) / data.length;
  const variance =
    data.reduce((acc, curr) => acc + Math.pow(curr.amount - mean, 2), 0) /
    data.length;
  const stdDev = Math.sqrt(variance);

  return data.map((d) => {
    if (stdDev === 0) {
      return {
        date: d.date,
        amount: d.amount,
        zScore: 0,
        isAnomaly: false,
        type: "normal",
      };
    }

    const zScore = Number(((d.amount - mean) / stdDev).toFixed(2));
    const isAnomaly = Math.abs(zScore) >= zThreshold;
    const type: "spike" | "dip" | "normal" = isAnomaly
      ? zScore > 0
        ? "spike"
        : "dip"
      : "normal";

    return {
      date: d.date,
      amount: d.amount,
      zScore,
      isAnomaly,
      type,
    };
  });
}

/**
 * Calculates variance from expected daily earnings and categorizes into red/yellow/green heatmap cells.
 */
export function calculateHeatmapVariance(
  data: DailyPoint[],
  windowSize = 7,
): HeatmapCell[] {
  if (data.length === 0) return [];
  const maPoints = calculateMovingAverage(data, windowSize);

  return data.map((d, index) => {
    // Expected is baseline rolling moving average or mean up to current point
    const expected = maPoints[index]?.movingAverage ?? d.amount;
    let variancePct = 0;

    if (expected > 0) {
      variancePct = Number((((d.amount - expected) / expected) * 100).toFixed(1));
    } else if (d.amount > 0) {
      variancePct = 100;
    }

    let status: "green" | "yellow" | "red" = "green";
    if (expected > 0 && d.amount < 0.6 * expected) {
      status = "red";
    } else if (expected > 0 && d.amount < 0.9 * expected) {
      status = "yellow";
    }

    return {
      date: d.date,
      actual: d.amount,
      expected: Number(expected.toFixed(2)),
      variancePct,
      status,
    };
  });
}

/**
 * Aggregates raw payout records into daily points sorted chronologically.
 */
export function aggregateByDay(payouts: PayoutRecord[]): DailyPoint[] {
  const map = new Map<string, number>();

  for (const payout of payouts) {
    if (!payout.timestamp) continue;
    const dateStr = new Date(payout.timestamp).toISOString().slice(0, 10);
    const val = typeof payout.amount === "number" ? payout.amount : parseFloat(payout.amount) || 0;
    map.set(dateStr, (map.get(dateStr) ?? 0) + val);
  }

  return Array.from(map.entries())
    .map(([date, amount]) => ({ date, amount: Number(amount.toFixed(2)) }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Aggregates raw payout records for a specific date into 24 hourly buckets.
 */
export function aggregateByHour(
  payouts: PayoutRecord[],
  targetDate: string,
): HourlyPoint[] {
  const hourlyBuckets = Array.from({ length: 24 }, (_, i) => ({
    hour: i,
    label: `${i.toString().padStart(2, "0")}:00`,
    amount: 0,
    count: 0,
  }));

  for (const payout of payouts) {
    if (!payout.timestamp) continue;
    const payoutDate = new Date(payout.timestamp);
    const dateStr = payoutDate.toISOString().slice(0, 10);
    if (dateStr === targetDate) {
      const hour = payoutDate.getUTCHours();
      const val = typeof payout.amount === "number" ? payout.amount : parseFloat(payout.amount) || 0;
      hourlyBuckets[hour].amount += val;
      hourlyBuckets[hour].count += 1;
    }
  }

  return hourlyBuckets.map((b) => ({
    ...b,
    amount: Number(b.amount.toFixed(2)),
  }));
}
