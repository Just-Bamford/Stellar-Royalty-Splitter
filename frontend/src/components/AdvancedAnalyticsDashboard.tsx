import React, { useMemo, useState } from "react";
import {
  ComposedChart,
  Line,
  Area,
  Scatter,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ResponsiveContainer,
  CartesianGrid,
  BarChart,
  Bar,
} from "recharts";
import {
  aggregateByDay,
  aggregateByHour,
  calculateHeatmapVariance,
  calculateLinearForecast,
  calculateMovingAverage,
  detectAnomalies,
  type DailyPoint,
  type PayoutRecord,
} from "../lib/advanced-analytics";
import { formatCurrency } from "../utils/format";
import { useSettings } from "../context/SettingsContext";
import "./AdvancedAnalyticsDashboard.css";

interface AdvancedAnalyticsDashboardProps {
  payouts: PayoutRecord[];
  contractId?: string;
}

export const AdvancedAnalyticsDashboard: React.FC<
  AdvancedAnalyticsDashboardProps
> = ({ payouts }) => {
  const { settings } = useSettings();

  // Interactive state
  const [rangeDays, setRangeDays] = useState<number>(30);
  const [forecastHorizon, setForecastHorizon] = useState<number>(14);
  const [showMA, setShowMA] = useState<boolean>(true);
  const [showForecast, setShowForecast] = useState<boolean>(true);
  const [showAnomalies, setShowAnomalies] = useState<boolean>(true);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);

  // 1. Process daily aggregated time-series
  const allDailyPoints: DailyPoint[] = useMemo(() => {
    return aggregateByDay(payouts);
  }, [payouts]);

  // Filter based on selected time range
  const dailyPoints: DailyPoint[] = useMemo(() => {
    if (allDailyPoints.length === 0) return [];
    if (rangeDays === 0) return allDailyPoints;
    return allDailyPoints.slice(-rangeDays);
  }, [allDailyPoints, rangeDays]);

  // 2. Calculations
  const movingAverageData = useMemo(() => {
    return calculateMovingAverage(dailyPoints, 7);
  }, [dailyPoints]);

  const forecastData = useMemo(() => {
    return calculateLinearForecast(dailyPoints, forecastHorizon, 0.95);
  }, [dailyPoints, forecastHorizon]);

  const anomalyData = useMemo(() => {
    return detectAnomalies(dailyPoints, 2.0);
  }, [dailyPoints]);

  const heatmapCells = useMemo(() => {
    return calculateHeatmapVariance(dailyPoints, 7);
  }, [dailyPoints]);

  // Combined chart dataset merging actuals, MA, forecast, & confidence bounds
  const chartCombinedData = useMemo(() => {
    const map = new Map<string, any>();

    // Add historical actuals and MA
    movingAverageData.forEach((pt, index) => {
      const anomaly = anomalyData[index];
      map.set(pt.date, {
        date: pt.date,
        actual: pt.amount,
        movingAverage: pt.movingAverage,
        anomalyAmount: anomaly?.isAnomaly ? pt.amount : null,
        anomalyType: anomaly?.type,
      });
    });

    // Add forecast & confidence bounds
    if (showForecast) {
      forecastData.forEach((pt) => {
        map.set(pt.date, {
          date: pt.date,
          forecast: pt.forecastedAmount,
          confidenceBand: [pt.lowerBound, pt.upperBound],
          lowerBound: pt.lowerBound,
          upperBound: pt.upperBound,
        });
      });
    }

    return Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
  }, [movingAverageData, forecastData, anomalyData, showForecast]);

  // Filtered anomalies list
  const identifiedAnomalies = useMemo(() => {
    return anomalyData.filter((a) => a.isAnomaly);
  }, [anomalyData]);

  // Hourly drill-down data
  const hourlyData = useMemo(() => {
    if (!selectedDate) return [];
    return aggregateByHour(payouts, selectedDate);
  }, [payouts, selectedDate]);

  const dayTotal = useMemo(() => {
    if (!selectedDate) return 0;
    const match = dailyPoints.find((d) => d.date === selectedDate);
    return match ? match.amount : 0;
  }, [dailyPoints, selectedDate]);

  return (
    <div
      className="advanced-analytics-dashboard"
      data-testid="advanced-analytics-dashboard"
    >
      <header className="analytics-header">
        <div className="analytics-title-group">
          <h2>📊 Advanced Analytics Dashboard</h2>
          <p className="subtitle">
            7-day moving averages, linear forecasts with confidence intervals,
            variance heatmap, and anomaly detection.
          </p>
        </div>

        <div className="analytics-controls">
          <div className="control-group">
            <label htmlFor="analytics-range-select">Period:</label>
            <select
              id="analytics-range-select"
              className="analytics-select"
              value={rangeDays}
              onChange={(e) => setRangeDays(Number(e.target.value))}
            >
              <option value={7}>Last 7 Days</option>
              <option value={14}>Last 14 Days</option>
              <option value={30}>Last 30 Days</option>
              <option value={90}>Last 90 Days</option>
            </select>
          </div>

          <div className="control-group">
            <label htmlFor="analytics-horizon-select">Forecast Horizon:</label>
            <select
              id="analytics-horizon-select"
              className="analytics-select"
              value={forecastHorizon}
              onChange={(e) => setForecastHorizon(Number(e.target.value))}
            >
              <option value={7}>+7 Days</option>
              <option value={14}>+14 Days</option>
              <option value={30}>+30 Days</option>
            </select>
          </div>

          <div className="analytics-toggles">
            <label className="toggle-label">
              <input
                type="checkbox"
                checked={showMA}
                onChange={(e) => setShowMA(e.target.checked)}
              />
              7-Day MA
            </label>
            <label className="toggle-label">
              <input
                type="checkbox"
                checked={showForecast}
                onChange={(e) => setShowForecast(e.target.checked)}
              />
              Forecast Band
            </label>
            <label className="toggle-label">
              <input
                type="checkbox"
                checked={showAnomalies}
                onChange={(e) => setShowAnomalies(e.target.checked)}
              />
              Anomalies
            </label>
          </div>
        </div>
      </header>

      {/* Drill-down View when a date is selected */}
      {selectedDate ? (
        <section
          className="drilldown-view"
          data-testid="analytics-drilldown-view"
        >
          <div className="drilldown-header">
            <div>
              <h3>
                Drill-Down Detail: {selectedDate}{" "}
                <span style={{ fontSize: "0.9rem", color: "#94a3b8" }}>
                  ({formatCurrency(dayTotal, settings.displayCurrency)} total)
                </span>
              </h3>
              <p style={{ margin: 0, fontSize: "0.82rem", color: "#94a3b8" }}>
                Hourly breakdown of payouts recorded on {selectedDate}.
              </p>
            </div>
            <button
              type="button"
              className="back-btn"
              onClick={() => setSelectedDate(null)}
              data-testid="drilldown-back-btn"
            >
              ← Back to Overview
            </button>
          </div>

          <div className="hourly-chart-container">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={hourlyData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                <XAxis dataKey="label" stroke="#94a3b8" tick={{ fontSize: 11 }} />
                <YAxis stroke="#94a3b8" tick={{ fontSize: 11 }} />
                <Tooltip
                  formatter={(val: number) =>
                    formatCurrency(val, settings.displayCurrency)
                  }
                  contentStyle={{
                    background: "#0f172a",
                    border: "1px solid #334155",
                    borderRadius: "8px",
                  }}
                />
                <Bar
                  dataKey="amount"
                  name="Hourly Earnings"
                  fill="#6366f1"
                  radius={[4, 4, 0, 0]}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>

          <table className="hourly-table">
            <thead>
              <tr>
                <th>Hour (UTC)</th>
                <th>Transactions</th>
                <th>Total Earned</th>
              </tr>
            </thead>
            <tbody>
              {hourlyData.map((h) => (
                <tr key={h.hour}>
                  <td>{h.label}</td>
                  <td>{h.count}</td>
                  <td>{formatCurrency(h.amount, settings.displayCurrency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : (
        <>
          {/* Chart Section */}
          <section className="chart-section" aria-label="Earnings Trend & Forecast Chart">
            <div className="chart-header">
              <span className="chart-title">
                📈 Trend &amp; Extrapolated Forecast
              </span>
            </div>

            <div className="chart-container-inner">
              {chartCombinedData.length === 0 ? (
                <div
                  style={{
                    display: "flex",
                    height: "100%",
                    alignItems: "center",
                    justifyContent: "center",
                    color: "#94a3b8",
                  }}
                >
                  No payout data available for selected period.
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart
                    data={chartCombinedData}
                    onClick={(state) => {
                      if (state && state.activePayload && state.activePayload.length > 0) {
                        const date = state.activePayload[0].payload.date;
                        if (date) setSelectedDate(date);
                      }
                    }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                    <XAxis
                      dataKey="date"
                      stroke="#94a3b8"
                      tick={{ fontSize: 11 }}
                    />
                    <YAxis stroke="#94a3b8" tick={{ fontSize: 11 }} />
                    <Tooltip
                      formatter={(value: any, name: string) => {
                        if (Array.isArray(value)) {
                          return `${formatCurrency(
                            value[0],
                            settings.displayCurrency,
                          )} – ${formatCurrency(
                            value[1],
                            settings.displayCurrency,
                          )}`;
                        }
                        if (typeof value === "number") {
                          return formatCurrency(value, settings.displayCurrency);
                        }
                        return value;
                      }}
                      contentStyle={{
                        background: "#0f172a",
                        border: "1px solid #334155",
                        borderRadius: "8px",
                      }}
                    />
                    <Legend />

                    {/* Confidence Band Area */}
                    {showForecast && (
                      <Area
                        type="monotone"
                        dataKey="confidenceBand"
                        name="95% Confidence Interval"
                        fill="#818cf8"
                        fillOpacity={0.15}
                        stroke="none"
                      />
                    )}

                    {/* Actual Daily Line */}
                    <Line
                      type="monotone"
                      dataKey="actual"
                      name="Actual Earnings"
                      stroke="#38bdf8"
                      strokeWidth={2.5}
                      dot={{ r: 3, cursor: "pointer" }}
                    />

                    {/* 7-Day Moving Average Line */}
                    {showMA && (
                      <Line
                        type="monotone"
                        dataKey="movingAverage"
                        name="7-Day Moving Avg"
                        stroke="#a855f7"
                        strokeWidth={2}
                        strokeDasharray="4 4"
                        dot={false}
                      />
                    )}

                    {/* Forecast Extrapolation Line */}
                    {showForecast && (
                      <Line
                        type="monotone"
                        dataKey="forecast"
                        name="Projected Forecast"
                        stroke="#f59e0b"
                        strokeWidth={2}
                        strokeDasharray="3 3"
                        dot={{ r: 3 }}
                      />
                    )}

                    {/* Anomaly Scatter Points */}
                    {showAnomalies && (
                      <Scatter
                        dataKey="anomalyAmount"
                        name="Anomaly Outlier"
                        fill="#ef4444"
                        shape="circle"
                      />
                    )}
                  </ComposedChart>
                </ResponsiveContainer>
              )}
            </div>
          </section>

          {/* Variance Heatmap Section */}
          <section className="heatmap-section" aria-label="Earnings Variance Heatmap">
            <div className="heatmap-header">
              <span className="chart-title">
                🗓️ Earnings Variance Heatmap (vs Expected Baseline)
              </span>
              <div className="heatmap-legend">
                <div className="legend-item">
                  <span className="legend-dot green"></span>
                  <span>On Track (&ge;90%)</span>
                </div>
                <div className="legend-item">
                  <span className="legend-dot yellow"></span>
                  <span>Moderate Dip (60-89%)</span>
                </div>
                <div className="legend-item">
                  <span className="legend-dot red"></span>
                  <span>Severe Dip (&lt;60%)</span>
                </div>
              </div>
            </div>

            <div className="heatmap-grid" data-testid="analytics-heatmap-grid">
              {heatmapCells.map((cell) => (
                <div
                  key={cell.date}
                  className={`heatmap-cell status-${cell.status}`}
                  onClick={() => setSelectedDate(cell.date)}
                  title={`Click to drill down into ${cell.date}`}
                  data-testid={`heatmap-cell-${cell.date}`}
                >
                  <div className="cell-date">{cell.date.slice(5)}</div>
                  <div className="cell-amount">
                    {formatCurrency(cell.actual, settings.displayCurrency)}
                  </div>
                  <div className={`cell-variance ${cell.status}`}>
                    {cell.variancePct >= 0 ? "+" : ""}
                    {cell.variancePct}%
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* Anomalies Outlier Section */}
          {identifiedAnomalies.length > 0 && (
            <section
              className="anomalies-section"
              data-testid="analytics-anomalies-section"
            >
              <div className="anomalies-title">
                <span>🚨 Detected Anomalies &amp; Outliers ({identifiedAnomalies.length})</span>
              </div>
              <div className="anomalies-list">
                {identifiedAnomalies.map((anom) => (
                  <div key={anom.date} className="anomaly-item">
                    <div>
                      <strong>{anom.date}</strong>: Earned{" "}
                      {formatCurrency(anom.amount, settings.displayCurrency)} (Z-score:{" "}
                      {anom.zScore})
                    </div>
                    <span className={`anomaly-badge ${anom.type}`}>
                      {anom.type}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
};
