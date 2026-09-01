import React, { useMemo, useState } from "react";
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  ReferenceLine,
  ComposedChart,
} from "recharts";
import { formatCurrency } from "../../utils/format";

export interface TrendPoint {
  date: string;
  amount: number;
  count: number;
  movingAverage?: number;
  forecast?: number;
  performance?: "good" | "fair" | "poor";
}

interface EarningsChartProps {
  trends: TrendPoint[];
  displayCurrency: string;
}

function calculateMovingAverage(data: TrendPoint[], period: number = 7): TrendPoint[] {
  return data.map((point, idx) => {
    if (idx < period - 1) return point;
    const window = data.slice(idx - period + 1, idx + 1);
    const avg = window.reduce((sum, d) => sum + d.amount, 0) / period;
    return { ...point, movingAverage: avg };
  });
}

function calculateForecast(data: TrendPoint[]): TrendPoint[] {
  if (data.length < 2) return data;

  const recent = data.slice(-7);
  const avgDailyGrowth = recent.length > 1
    ? (recent[recent.length - 1].amount - recent[0].amount) / (recent.length - 1)
    : 0;

  const lastDate = new Date(data[data.length - 1].date);
  const daysToMonthEnd = new Date(lastDate.getFullYear(), lastDate.getMonth() + 1, 0).getDate() - lastDate.getDate();
  const forecastAmount = data[data.length - 1].amount + (avgDailyGrowth * daysToMonthEnd);

  return data.map((point, idx) => {
    if (idx === data.length - 1) {
      return { ...point, forecast: Math.max(0, forecastAmount) };
    }
    return point;
  });
}

function getPerformanceHeat(amount: number, avgAmount: number): "good" | "fair" | "poor" {
  if (amount >= avgAmount * 1.2) return "good";
  if (amount >= avgAmount * 0.8) return "fair";
  return "poor";
}

/**
 * EarningsChart — renders analytics with:
 * 1. Revenue Trends with 7-day moving average overlay
 * 2. Distribution Frequency
 * 3. Forecast widget with confidence (linear extrapolation)
 * 4. Performance heat map visualization
 * 5. Drill-down capability via chart interactions
 */
export const EarningsChart: React.FC<EarningsChartProps> = ({
  trends,
  displayCurrency,
}) => {
  const [selectedDrillPoint, setSelectedDrillPoint] = useState<TrendPoint | null>(null);
  const [movingAvgPeriod, setMovingAvgPeriod] = useState(7);

  const chartDataWithMA = useMemo(
    () => calculateMovingAverage(trends, movingAvgPeriod),
    [trends, movingAvgPeriod]
  );

  const chartDataWithForecast = useMemo(
    () => calculateForecast(chartDataWithMA),
    [chartDataWithMA]
  );

  const chartDataWithPerformance = useMemo(() => {
    const avg = trends.length > 0
      ? trends.reduce((sum, d) => sum + d.amount, 0) / trends.length
      : 0;
    return chartDataWithForecast.map(point => ({
      ...point,
      performance: getPerformanceHeat(point.amount, avg)
    }));
  }, [chartDataWithForecast, trends]);

  const forecastData = chartDataWithForecast.find(d => d.forecast);
  const confidence = forecastData ? "linear extrapolation based on last 7 days" : "";

  const noData = <div className="no-data">No data available</div>;

  return (
    <div className="charts-section">
      <div className="chart-container">
        <div className="chart-header">
          <h2>Revenue Trends with Forecast</h2>
          <div className="chart-controls">
            <label htmlFor="ma-period">Moving Average Period:</label>
            <select
              id="ma-period"
              value={movingAvgPeriod}
              onChange={(e) => setMovingAvgPeriod(parseInt(e.target.value))}
              aria-label="Moving average period in days"
            >
              <option value={3}>3 days</option>
              <option value={7}>7 days</option>
              <option value={14}>14 days</option>
              <option value={30}>30 days</option>
            </select>
          </div>
        </div>

        {chartDataWithPerformance.length > 0 ? (
          <>
            <ResponsiveContainer width="100%" height={320}>
              <ComposedChart data={chartDataWithPerformance}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="date" />
                <YAxis />
                <Tooltip
                  formatter={(value) =>
                    typeof value === "number"
                      ? formatCurrency(value, displayCurrency)
                      : value
                  }
                  content={({ active, payload }) => {
                    if (active && payload?.[0]) {
                      const data = payload[0].payload as TrendPoint;
                      return (
                        <div className="custom-tooltip" style={{ background: "#fff", border: "1px solid #ccc", padding: "8px" }}>
                          <p>{data.date}</p>
                          <p>Amount: {formatCurrency(data.amount, displayCurrency)}</p>
                          {data.movingAverage && (
                            <p>MA: {formatCurrency(data.movingAverage, displayCurrency)}</p>
                          )}
                          {data.forecast && (
                            <p className="forecast-tooltip">
                              Forecast: {formatCurrency(data.forecast, displayCurrency)}
                              <small style={{ display: "block" }}>({confidence})</small>
                            </p>
                          )}
                          <p>Transactions: {data.count}</p>
                        </div>
                      );
                    }
                    return null;
                  }}
                />
                <Legend />
                <Line
                  type="monotone"
                  dataKey="amount"
                  stroke="#667eea"
                  name="Total Amount"
                  strokeWidth={2}
                  dot={false}
                  onClick={(data) => setSelectedDrillPoint(data as TrendPoint)}
                />
                {chartDataWithPerformance.some(d => d.movingAverage) && (
                  <Line
                    type="monotone"
                    dataKey="movingAverage"
                    stroke="#f59e0b"
                    name={`${movingAvgPeriod}-Day MA`}
                    strokeWidth={2}
                    strokeDasharray="5 5"
                    dot={false}
                  />
                )}
                {chartDataWithPerformance.some(d => d.forecast) && (
                  <Line
                    type="monotone"
                    dataKey="forecast"
                    stroke="#22c55e"
                    name="Month-End Forecast"
                    strokeWidth={2}
                    strokeDasharray="3 3"
                    dot={false}
                  />
                )}
              </ComposedChart>
            </ResponsiveContainer>

            {selectedDrillPoint && (
              <div className="drill-down-details" role="region" aria-label="Drill-down details">
                <h3>Day-Level Details: {selectedDrillPoint.date}</h3>
                <div className="details-grid">
                  <div className="detail-card">
                    <span className="detail-label">Total Distributed</span>
                    <strong>{formatCurrency(selectedDrillPoint.amount, displayCurrency)}</strong>
                  </div>
                  <div className="detail-card">
                    <span className="detail-label">Transactions</span>
                    <strong>{selectedDrillPoint.count}</strong>
                  </div>
                  {selectedDrillPoint.movingAverage && (
                    <div className="detail-card">
                      <span className="detail-label">{movingAvgPeriod}-Day Average</span>
                      <strong>{formatCurrency(selectedDrillPoint.movingAverage, displayCurrency)}</strong>
                    </div>
                  )}
                  <div className="detail-card">
                    <span className="detail-label">Performance</span>
                    <strong className={`perf-${selectedDrillPoint.performance}`}>
                      {selectedDrillPoint.performance?.toUpperCase()}
                    </strong>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setSelectedDrillPoint(null)}
                  className="close-drill-btn"
                >
                  Close
                </button>
              </div>
            )}

            {forecastData && (
              <div className="forecast-widget" role="region" aria-label="Earnings forecast">
                <h3>Month-End Forecast</h3>
                <div className="forecast-content">
                  <div className="forecast-amount">
                    <span className="forecast-label">Projected earnings by month-end</span>
                    <strong>{formatCurrency(forecastData.forecast, displayCurrency)}</strong>
                  </div>
                  <div className="forecast-confidence">
                    <small>Assumption: {confidence}</small>
                  </div>
                </div>
              </div>
            )}
          </>
        ) : (
          noData
        )}
      </div>

      <div className="chart-container">
        <h2>Distribution Frequency & Performance Heat</h2>
        {chartDataWithPerformance.length > 0 ? (
          <>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={chartDataWithPerformance}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="date" />
                <YAxis />
                <Tooltip />
                <Legend />
                <Bar
                  dataKey="count"
                  fill="#764ba2"
                  name="Number of Transactions"
                  radius={[4, 4, 0, 0]}
                />
              </BarChart>
            </ResponsiveContainer>

            <div className="performance-heat-map">
              <h3>Performance Heat Map</h3>
              <div className="heat-legend">
                <span className="heat-item good">Good: +20% above average</span>
                <span className="heat-item fair">Fair: Within ±20% of average</span>
                <span className="heat-item poor">Poor: Below 80% of average</span>
              </div>
              <div className="heat-grid">
                {chartDataWithPerformance.map((point) => (
                  <div
                    key={point.date}
                    className={`heat-cell heat-${point.performance}`}
                    title={`${point.date}: ${formatCurrency(point.amount, displayCurrency)}`}
                  >
                    {new Date(point.date).getDate()}
                  </div>
                ))}
              </div>
            </div>
          </>
        ) : (
          noData
        )}
      </div>
    </div>
  );
};

export default EarningsChart;
