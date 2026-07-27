import { useState, useEffect, useCallback } from "react";
import { api } from "../api";
import "./SystemHealthDashboard.css";

type HealthData = Awaited<ReturnType<typeof api.getHealth>>;

function StatusBadge({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={`health-badge health-badge--${ok ? "ok" : "error"}`}>
      {ok ? "✓" : "✕"} {label}
    </span>
  );
}

export function SystemHealthDashboard() {
  const [health, setHealth] = useState<HealthData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.getHealth();
      setHealth(data);
      setLastRefreshed(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load health data");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    // Auto-refresh every 30 seconds
    const interval = setInterval(() => void load(), 30_000);
    return () => clearInterval(interval);
  }, [load]);

  return (
    <div className="health-dashboard">
      <div className="health-header">
        <div>
          <h2 className="health-title">System Health</h2>
          {lastRefreshed && (
            <p className="health-subtitle">
              Last updated {lastRefreshed.toLocaleTimeString()}
            </p>
          )}
        </div>
        <button
          className="health-refresh-btn"
          onClick={() => void load()}
          disabled={loading}
          aria-label="Refresh health status"
        >
          {loading ? "Refreshing…" : "↺ Refresh"}
        </button>
      </div>

      {error && (
        <div className="health-error" role="alert">
          {error}
        </div>
      )}

      {loading && !health && (
        <div className="health-loading" aria-busy="true">
          Loading system status…
        </div>
      )}

      {health && (
        <>
          {/* Overall status banner */}
          <div className={`health-overall health-overall--${health.ok ? "ok" : "degraded"}`}>
            <span className="health-overall-icon">{health.ok ? "🟢" : "🔴"}</span>
            <span className="health-overall-text">
              {health.ok ? "All systems operational" : "System degraded — check details below"}
            </span>
          </div>

          {/* Status cards */}
          <div className="health-cards">
            {/* Horizon */}
            <div className="health-card">
              <h3 className="health-card-title">Horizon Network</h3>
              <StatusBadge ok={health.horizon.connected} label={health.horizon.connected ? "Connected" : "Unreachable"} />
              <div className="health-card-meta">
                <span className="health-label">Network</span>
                <span className="health-value">{health.network}</span>
              </div>
              <div className="health-card-meta">
                <span className="health-label">URL</span>
                <span className="health-value health-value--mono">{health.horizon.url}</span>
              </div>
            </div>

            {/* Contract */}
            <div className="health-card">
              <h3 className="health-card-title">Smart Contract</h3>
              {health.contract.configured ? (
                <>
                  <StatusBadge
                    ok={health.contract.deployed && health.contract.status !== "error"}
                    label={health.contract.status}
                  />
                  <div className="health-card-meta">
                    <span className="health-label">Contract ID</span>
                    <span className="health-value health-value--mono">
                      {health.contract.contractId
                        ? `${health.contract.contractId.slice(0, 8)}…${health.contract.contractId.slice(-6)}`
                        : "—"}
                    </span>
                  </div>
                  <div className="health-card-meta">
                    <span className="health-label">Initialized</span>
                    <span className="health-value">{health.contract.initialized ? "Yes" : "No"}</span>
                  </div>
                </>
              ) : (
                <span className="health-badge health-badge--warn">⚠ Not configured</span>
              )}
            </div>

            {/* Database */}
            <div className="health-card">
              <h3 className="health-card-title">Database</h3>
              <StatusBadge ok={true} label="Operational" />
              <div className="health-card-meta">
                <span className="health-label">Schema version</span>
                <span className="health-value">v{health.dbVersion}</span>
              </div>
              {health.dbMetrics && (
                <>
                  <div className="health-card-meta">
                    <span className="health-label">Total transactions</span>
                    <span className="health-value">{health.dbMetrics.transactions.total.toLocaleString()}</span>
                  </div>
                  <div className="health-card-meta">
                    <span className="health-label">Failed transactions</span>
                    <span className={`health-value${health.dbMetrics.transactions.failed > 0 ? " health-value--warn" : ""}`}>
                      {health.dbMetrics.transactions.failed.toLocaleString()}
                    </span>
                  </div>
                  <div className="health-card-meta">
                    <span className="health-label">Pending transactions</span>
                    <span className="health-value">{health.dbMetrics.transactions.pending.toLocaleString()}</span>
                  </div>
                  {health.dbMetrics.transactions.lastActivity && (
                    <div className="health-card-meta">
                      <span className="health-label">Last activity</span>
                      <span className="health-value">
                        {new Date(health.dbMetrics.transactions.lastActivity).toLocaleString()}
                      </span>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>

          <p className="health-generated-at">
            Report generated at {new Date(health.generatedAt).toLocaleString()}
          </p>
        </>
      )}
    </div>
  );
}
