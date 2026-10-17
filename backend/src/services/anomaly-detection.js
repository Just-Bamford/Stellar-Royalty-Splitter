export const DEFAULT_THRESHOLDS = Object.freeze({ volumeMultiplier: 2, errorRate: 0.05, minimumSamples: 3 });

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function detectAnalyticsAnomalies(hourly, thresholds = {}) {
  const config = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const rows = [...(hourly ?? [])].sort((a, b) => String(a.bucket).localeCompare(String(b.bucket)));
  if (rows.length === 0) return [];
  const latest = rows[rows.length - 1];
  const history = rows.slice(0, -1);
  const baseline = history.length ? history.reduce((sum, row) => sum + number(row.distributionCount), 0) / history.length : 0;
  const latestVolume = number(latest.distributionCount);
  const latestTotal = latestVolume + number(latest.failedCount);
  const anomalies = [];
  if (history.length >= config.minimumSamples && baseline > 0 && latestVolume > baseline * config.volumeMultiplier) {
    anomalies.push({ type: "volume_spike", severity: "warning", bucket: latest.bucket, baseline, current: latestVolume, threshold: config.volumeMultiplier });
  }
  const errorRate = latestTotal > 0 ? number(latest.failedCount) / latestTotal : 0;
  if (errorRate > config.errorRate) {
    anomalies.push({ type: "error_rate_spike", severity: errorRate > config.errorRate * 2 ? "critical" : "warning", bucket: latest.bucket, current: errorRate, threshold: config.errorRate });
  }
  if (latestVolume > 0 && number(latest.collaboratorEarnings) === 0) {
    anomalies.push({ type: "zero_collaborator_earnings", severity: "critical", bucket: latest.bucket, current: 0 });
  }
  return anomalies;
}

export function evaluateAnalyticsAlerts(snapshot, onAlert = () => {}, thresholds) {
  const anomalies = detectAnalyticsAnomalies(snapshot?.hourly, thresholds);
  for (const anomaly of anomalies) onAlert(anomaly);
  return anomalies;
}
