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
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dateRange, setDateRange] = useState<{ start: string; end: string }>({
    start: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
      .toISOString()
      .split("T")[0],
    end: new Date().toISOString().split("T")[0],
  });

  useEffect(() => {
    loadStats();
  }, [contractId, dateRange]);

  const loadStats = async () => {
    if (!contractId) {
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const response = await api.getAnalytics(contractId, dateRange);

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
          <input
            type="date"
            value={dateRange.start}
            onChange={(e) =>
              setDateRange({ ...dateRange, start: e.target.value })
            }
          />
          <span>to</span>
          <input
            type="date"
            value={dateRange.end}
            onChange={(e) => setDateRange({ ...dateRange, end: e.target.value })}
          />
          <button onClick={loadStats} className="refresh-btn">
            🔄 Refresh
          </button>
        </div>
      </div>

      {loading && (
        <div className="loading">
          <span className="spinner"></span> Loading analytics...
        </div>
      )}

      {error && <div className="error-message">{error}</div>}

      {stats && !loading && (
        <>
          {/* KPI Cards */}
          <div className="kpi-cards">
            <div className="kpi-card">
              <div className="kpi-icon">💰</div>
              <div className="kpi-content">
                <div className="kpi-label">Total Distributed</div>
                <div className="kpi-value">
                  {stats.totalDistributed.toLocaleString("en-US", {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}
                </div>
                <div className="kpi-unit">Stellar</div>
              </div>
            </div>

            <div className="kpi-card">
              <div className="kpi-icon">📈</div>
              <div className="kpi-content">
                <div className="kpi-label">Total Transactions</div>
                <div className="kpi-value">{stats.totalTransactions}</div>
                <div className="kpi-unit">payouts</div>
              </div>
            </div>

            <div className="kpi-card">
              <div className="kpi-icon">📊</div>
              <div className="kpi-content">
                <div className="kpi-label">Average Payout</div>
                <div className="kpi-value">
                  {stats.averagePayout.toLocaleString("en-US", {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}
                </div>
                <div className="kpi-unit">per transaction</div>
              </div>
            </div>

            <div className="kpi-card">
              <div className="kpi-icon">👥</div>
              <div className="kpi-content">
                <div className="kpi-label">Active Collaborators</div>
                <div className="kpi-value">{stats.collaboratorStats.length}</div>
                <div className="kpi-unit">unique addresses</div>
              </div>
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
                        typeof value === "number"
                          ? value.toFixed(2)
                          : value
                      }
                    />
                    <Legend />
                    <Line
                      type="monotone"
                      dataKey="amount"
                      stroke="#667eea"
                      name="Total Amount (XLM)"
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
                          💰{" "}
                          {earner.totalEarned.toLocaleString("en-US", {
                            minimumFractionDigits: 2,
                            maximumFractionDigits: 2,
                          })}
                        </span>
                        <span className="earner-count">
                          📊 {earner.payouts} payouts
                        </span>
                      </div>
                    </div>
                    <div className="earner-percentage">
                      {(
                        (earner.totalEarned / stats.totalDistributed) *
                        100
                      ).toFixed(1)}
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
                          {collab.totalEarned.toLocaleString("en-US", {
                            minimumFractionDigits: 2,
                            maximumFractionDigits: 2,
                          })}
                        </td>
                        <td className="text-right">{collab.payoutCount}</td>
                        <td className="text-right">
                          {(collab.totalEarned / collab.payoutCount).toLocaleString(
                            "en-US",
                            {
                              minimumFractionDigits: 2,
                              maximumFractionDigits: 2,
                            }
                          )}
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
