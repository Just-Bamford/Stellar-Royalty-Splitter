import { useState, useEffect } from "react";
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
} from "recharts";
import { api } from "../api";
import "./Dashboard.css";
import { useSettings } from "../context/SettingsContext";
import { formatNumber, formatCurrency } from "../utils/format";
import { DashboardSkeleton } from "./Skeleton";




interface DashboardStats {
  totalDistributed: number;
  totalTransactions: number;
  averagePayout: number;
  topEarners: Array<{ address: string; totalEarned: number; payouts: number }>;
  distributionTrends: Array<{ date: string; amount: number; count: number }>;
  collaboratorStats: Array<{
    address: string;
    totalEarned: number;
    payoutCount: number;
  }>;
}

interface DashboardProps {
  contractId: string;
}

export const Dashboard: React.FC<DashboardProps> = ({ contractId }) => {
  const { settings } = useSettings();
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [allTime, setAllTime] = useState(false);
  const [dateRange, setDateRange] = useState<{ start: string; end: string }>({
    start: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
      .toISOString()
      .split("T")[0],
    end: new Date().toISOString().split("T")[0],
  });
  const [dateError, setDateError] = useState<string | null>(null);
  const today = new Date().toISOString().split("T")[0];

  useEffect(() => {
    loadStats();
  }, [contractId, dateRange, allTime]);

  const loadStats = async () => {
    if (!contractId) {
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const response = await api.getAnalytics(contractId, allTime ? undefined : dateRange);

      if (response.success) {
        setStats(response.data);
      } else {
        setError(response.message || "Failed to load analytics");
      }
    } catch (err) {
      console.error("Error loading dashboard stats:", err);
      setError("Error loading analytics data");
    } finally {
      setLoading(false);
    }
  };

  if (!contractId) {
    return (
      <div className="dashboard-empty">
        <div className="empty-state">
          <div className="empty-icon">📊</div>
          <h2>No Contract Selected</h2>
          <p>Please initialize or select a contract to view analytics.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="dashboard">
      <div className="dashboard-header">
        <h1>Analytics Dashboard</h1>
        <div className="date-range-filter">
          <button
            onClick={() => setAllTime(!allTime)}
            className={`preset-btn${allTime ? " active" : ""}`}
          >
            All time
          </button>
          <input
            type="date"
            value={dateRange.start}
            max={today}
            disabled={allTime}
            onChange={(e) => {
              const start = e.target.value;
              if (start > dateRange.end) {
                setDateError("Start date must be on or before end date.");
              } else {
                setDateError(null);
                setDateRange({ ...dateRange, start });
              }
            }}
          />
          <span>to</span>
          <input
            type="date"
            value={dateRange.end}
            max={today}
            disabled={allTime}
            onChange={(e) => {
              const end = e.target.value;
              if (end < dateRange.start) {
                setDateError("End date must be on or after start date.");
              } else {
                setDateError(null);
                setDateRange({ ...dateRange, end });
              }
            }}
          />
          <button onClick={loadStats} className="refresh-btn">
            🔄 Refresh
          </button>
        </div>
        {dateError && <div className="date-error">{dateError}</div>}
      </div>

      {loading && <DashboardSkeleton />}


      {error && <div className="error-message">{error}</div>}

      {stats && !loading && (
        <>
          {stats.totalTransactions === 0 && (
            <div className="empty-data-warning">
              ⚠️ No data found for this period. Try widening your date range or selecting <strong>All time</strong>.
            </div>
          )}
          {/* KPI Cards */}
          <div className="kpi-cards">
              <div className="kpi-card kpi-distributed">
                <div className="kpi-label">Total Distributed</div>
                <div className="kpi-value">
                  {formatCurrency(stats.totalDistributed, settings.displayCurrency)}
                </div>
              </div>
 
            <div className="kpi-card kpi-transactions">
              <div className="kpi-label">Total Transactions</div>
              <div className="kpi-value">{formatNumber(stats.totalTransactions)}</div>
              <div className="kpi-unit">payouts</div>
            </div>

            <div className="kpi-card kpi-average">
              <div className="kpi-label">Average Payout</div>
              <div className="kpi-value">
                {formatCurrency(stats.averagePayout, settings.displayCurrency)}
              </div>
              <div className="kpi-unit">per transaction</div>
            </div>
 
            <div className="kpi-card kpi-collaborators">
              <div className="kpi-label">Active Collaborators</div>
              <div className="kpi-value">
                {formatNumber(stats.collaboratorStats.length)}
              </div>
              <div className="kpi-unit">unique addresses</div>
            </div>
          </div>

          {/* Charts */}
          <div className="charts-section">
            <div className="chart-container">
              <h2>Revenue Trends (Over Time)</h2>
              {stats.distributionTrends.length > 0 ? (
                <ResponsiveContainer width="100%" height={300}>
                  <LineChart data={stats.distributionTrends}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="date" />
                    <YAxis />
                    <Tooltip
                      formatter={(value) =>
                        typeof value === "number" ? formatCurrency(value, settings.displayCurrency) : value
                      }
                    />
                    <Legend />
                    <Line
                      type="monotone"
                      dataKey="amount"
                      stroke="#667eea"
                      name={`Total Amount (${settings.displayCurrency})`}
                      strokeWidth={2}
                      dot={{ fill: "#667eea", r: 4 }}
                    />
                  </LineChart>
                </ResponsiveContainer>
              ) : (
                <div className="no-data">No data available</div>
              )}
            </div>

            <div className="chart-container">
              <h2>Distribution Frequency</h2>
              {stats.distributionTrends.length > 0 ? (
                <ResponsiveContainer width="100%" height={300}>
                  <BarChart data={stats.distributionTrends}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="date" />
                    <YAxis />
                    <Tooltip />
                    <Legend />
                    <Bar
                      dataKey="count"
                      fill="#764ba2"
                      name="Number of Transactions"
                    />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <div className="no-data">No data available</div>
              )}
            </div>
          </div>

          {/* Top Earners */}
          <div className="top-earners-section">
            <h2>Top Earners</h2>
            <div className="earners-list">
              {stats.topEarners.length > 0 ? (
                stats.topEarners.map((earner, index) => (
                  <div key={index} className="earner-card">
                    <div className="earner-rank">#{index + 1}</div>
                    <div className="earner-info">
                      <div className="earner-address">
                        {earner.address.slice(0, 10)}...
                        {earner.address.slice(-6)}
                      </div>
                      <div className="earner-stats">
                        <span className="earner-amount">
                          {formatCurrency(earner.totalEarned, settings.displayCurrency)}
                        </span>
                        <span className="earner-count">
                          {formatNumber(earner.payouts)} payouts
                        </span>
                      </div>
                    </div>
                    <div className="earner-percentage">
                      {stats.totalDistributed > 0
                        ? ((earner.totalEarned / stats.totalDistributed) * 100).toFixed(1)
                        : "0.0"}
                      %
                    </div>
                  </div>
                ))
              ) : (
                <div className="no-data">No earnings yet</div>
              )}
            </div>
          </div>

          {/* Collaborator Stats */}
          <div className="collaborator-stats-section">
            <h2>Collaborator Summary</h2>
            <div className="stats-table">
              <table>
                <thead>
                  <tr>
                    <th>Collaborator</th>
                    <th className="text-right">Total Earned</th>
                    <th className="text-right">Payouts</th>
                    <th className="text-right">Avg Payout</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.collaboratorStats.length > 0 ? (
                    stats.collaboratorStats.map((collab, index) => (
                      <tr key={index}>
                        <td className="address-cell">
                          {collab.address.slice(0, 10)}...
                          {collab.address.slice(-6)}
                        </td>
                        <td className="text-right">
                          {formatCurrency(collab.totalEarned, settings.displayCurrency)}
                        </td>
                        <td className="text-right">{formatNumber(collab.payoutCount)}</td>
                        <td className="text-right">
                          {collab.payoutCount > 0
                            ? formatCurrency(collab.totalEarned / collab.payoutCount, settings.displayCurrency)
                            : formatCurrency(0, settings.displayCurrency)}
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={4} className="no-data">
                        No collaborator data
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
};
