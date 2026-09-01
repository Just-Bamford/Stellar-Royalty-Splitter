/**
 * HealthDashboard — system health overview with component status,
 * SLA tracking, and historical trends (#787).
 */
import { useState, useCallback } from "react";
import { api, HealthResponse, HealthHistoryEntry, SLAStats, HealthComponent } from "../api";
import { useHealth, useHealthHistory, useHealthSla } from "../hooks/queries/useHealth";

const STATUS_COLORS: Record<string, { bg: string; text: string; dot: string }> = {
  healthy:        { bg: "var(--color-success-bg, #d1fae5)",  text: "var(--color-success, #065f46)",  dot: "#10b981" },
  degraded:       { bg: "var(--color-warning-bg, #fef3c7)",  text: "var(--color-warning, #92400e)",  dot: "#f59e0b" },
  down:           { bg: "var(--color-error-bg, #fee2e2)",    text: "var(--color-error, #991b1b)",    dot: "#ef4444" },
  error:          { bg: "var(--color-error-bg, #fee2e2)",    text: "var(--color-error, #991b1b)",    dot: "#ef4444" },
  not_configured: { bg: "var(--color-neutral-bg, #f3f4f6)",  text: "var(--color-neutral, #374151)",  dot: "#9ca3af" },
  unknown:        { bg: "var(--color-neutral-bg, #f3f4f6)",  text: "var(--color-neutral, #374151)",  dot: "#9ca3af" },
};

function getStatusColors(status: string) {
  return STATUS_COLORS[status] ?? STATUS_COLORS.unknown;
}

function StatusBadge({ status }: { status: string }) {
  const colors = getStatusColors(status);
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "6px",
        padding: "3px 10px",
        borderRadius: "9999px",
        fontSize: "0.78rem",
        fontWeight: 600,
        background: colors.bg,
        color: colors.text,
      }}
    >
      <span
        style={{
          width: "8px",
          height: "8px",
          borderRadius: "50%",
          backgroundColor: colors.dot,
          flexShrink: 0,
        }}
        aria-hidden="true"
      />
      {status.replace(/_/g, " ")}
    </span>
  );
}

function ComponentCard({
  title,
  icon,
  component,
}: {
  title: string;
  icon: string;
  component: HealthComponent;
}) {
  return (
    <div
      style={{
        background: "var(--color-card-bg, #fff)",
        border: "1px solid var(--color-border, #e5e7eb)",
        borderRadius: "8px",
        padding: "16px 20px",
        display: "flex",
        flexDirection: "column",
        gap: "8px",
        minWidth: "180px",
        flex: "1",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
        <span style={{ fontSize: "1.2rem" }}>{icon}</span>
        <span style={{ fontWeight: 600, color: "var(--color-text, #111827)" }}>{title}</span>
      </div>
      <StatusBadge status={component.status} />
      {component.latencyMs !== undefined && (
        <span style={{ fontSize: "0.8rem", color: "var(--color-text-muted, #6b7280)" }}>
          Latency: <strong>{component.latencyMs} ms</strong>
        </span>
      )}
    </div>
  );
}

function OverallBanner({ ok }: { ok: boolean }) {
  const colors = ok ? STATUS_COLORS.healthy : STATUS_COLORS.error;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "12px",
        padding: "14px 20px",
        borderRadius: "8px",
        background: colors.bg,
        color: colors.text,
        fontWeight: 700,
        fontSize: "1rem",
        marginBottom: "24px",
      }}
      role="status"
      aria-live="polite"
    >
      <span
        style={{
          width: "14px",
          height: "14px",
          borderRadius: "50%",
          backgroundColor: colors.dot,
          flexShrink: 0,
        }}
        aria-hidden="true"
      />
      {ok ? "All systems operational" : "One or more systems degraded"}
    </div>
  );
}

function SLASection({ sla }: { sla: SLAStats }) {
  return (
    <div style={{ marginTop: "24px" }}>
      <h3 style={{ margin: "0 0 12px", fontSize: "1rem", fontWeight: 600 }}>
        📈 SLA — Last {sla.periodDays} days
      </h3>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "12px" }}>
        {[
          {
            label: "Uptime",
            value: `${sla.uptimePercent.toFixed(3)}%`,
            highlight: sla.uptimePercent >= 99.9,
          },
          { label: "Snapshots", value: String(sla.totalSnapshots) },
          { label: "Healthy", value: String(sla.healthySnapshots) },
          {
            label: "Avg Latency",
            value: sla.avgLatencyMs !== null ? `${sla.avgLatencyMs} ms` : "—",
          },
          {
            label: "Min Latency",
            value: sla.minLatencyMs !== null ? `${sla.minLatencyMs} ms` : "—",
          },
          {
            label: "Max Latency",
            value: sla.maxLatencyMs !== null ? `${sla.maxLatencyMs} ms` : "—",
          },
        ].map((stat) => (
          <div
            key={stat.label}
            style={{
              background: "var(--color-card-bg, #fff)",
              border: "1px solid var(--color-border, #e5e7eb)",
              borderRadius: "8px",
              padding: "12px 16px",
              minWidth: "110px",
              flex: "1",
            }}
          >
            <div style={{ fontSize: "0.75rem", color: "var(--color-text-muted, #6b7280)", marginBottom: "4px" }}>
              {stat.label}
            </div>
            <div
              style={{
                fontSize: "1.1rem",
                fontWeight: 700,
                color:
                  stat.highlight !== undefined
                    ? stat.highlight
                      ? "#065f46"
                      : "#991b1b"
                    : "var(--color-text, #111827)",
              }}
            >
              {stat.value}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function HistoryTable({ entries }: { entries: HealthHistoryEntry[] }) {
  if (entries.length === 0) {
    return (
      <p style={{ color: "var(--color-text-muted, #6b7280)", fontSize: "0.9rem" }}>
        No history recorded yet. Snapshots are saved once per hour when the health endpoint is polled.
      </p>
    );
  }

  return (
    <div style={{ overflowX: "auto" }}>
      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          fontSize: "0.85rem",
        }}
        aria-label="Health history"
      >
        <thead>
          <tr style={{ background: "var(--color-table-header-bg, #f9fafb)" }}>
            {["Timestamp", "Status", "Horizon", "Latency (ms)", "Contract", "DB"].map((h) => (
              <th
                key={h}
                style={{
                  padding: "8px 12px",
                  textAlign: "left",
                  fontWeight: 600,
                  borderBottom: "1px solid var(--color-border, #e5e7eb)",
                  whiteSpace: "nowrap",
                }}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr
              key={entry.id}
              style={{ borderBottom: "1px solid var(--color-border, #e5e7eb)" }}
            >
              <td style={{ padding: "7px 12px", whiteSpace: "nowrap" }}>
                {new Date(entry.timestamp).toLocaleString()}
              </td>
              <td style={{ padding: "7px 12px" }}>
                <StatusBadge status={entry.overall_ok ? "healthy" : "error"} />
              </td>
              <td style={{ padding: "7px 12px" }}>
                <StatusBadge status={entry.horizon_connected ? "healthy" : "down"} />
              </td>
              <td style={{ padding: "7px 12px" }}>
                {entry.horizon_latency_ms !== null ? entry.horizon_latency_ms : "—"}
              </td>
              <td style={{ padding: "7px 12px" }}>
                <StatusBadge status={entry.contract_status || "unknown"} />
              </td>
              <td style={{ padding: "7px 12px" }}>
                <StatusBadge status={entry.db_ok ? "healthy" : "degraded"} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function HealthDashboard() {
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  // React Query hooks — each has refetchInterval: 30_000 built in (#832).
  // This replaces the manual fetchAll + setInterval(fetchAll, 30_000) pattern.
  const healthQuery = useHealth();
  const historyQuery = useHealthHistory(24);
  const slaQuery = useHealthSla(30);

  const health = healthQuery.data ?? null;
  const history: HealthHistoryEntry[] = historyQuery.data?.data ?? [];
  const sla: SLAStats | null = slaQuery.data?.data ?? null;
  const loading = healthQuery.isLoading || historyQuery.isLoading || slaQuery.isLoading;
  const error =
    (healthQuery.isError ? (healthQuery.error as Error)?.message : null) ??
    (historyQuery.isError ? (historyQuery.error as Error)?.message : null) ??
    null;

  // Track when any of the queries last successfully updated
  const lastFetchTime =
    healthQuery.dataUpdatedAt > 0 ? new Date(healthQuery.dataUpdatedAt) : null;

  // Manual refresh: invalidate all health queries so they refetch immediately
  const handleRefresh = useCallback(() => {
    void healthQuery.refetch();
    void historyQuery.refetch();
    void slaQuery.refetch();
    setLastRefresh(new Date());
  }, [healthQuery, historyQuery, slaQuery]);

  if (loading) {
    return (
      <div style={{ padding: "24px" }}>
        <p style={{ color: "var(--color-text-muted, #6b7280)" }}>Loading health data…</p>
      </div>
    );
  }

  if (error && !health) {
    return (
      <div style={{ padding: "24px" }}>
        <div
          style={{
            padding: "16px 20px",
            borderRadius: "8px",
            background: "var(--color-error-bg, #fee2e2)",
            color: "var(--color-error, #991b1b)",
          }}
          role="alert"
        >
          <strong>Unable to load health data</strong>
          <p style={{ margin: "6px 0 0", fontSize: "0.9rem" }}>{error}</p>
        </div>
        <button
          onClick={fetchAll}
          style={{ marginTop: "12px" }}
          className="btn btn-secondary"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div style={{ padding: "24px", maxWidth: "900px" }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: "20px", flexWrap: "wrap", gap: "8px" }}>
        <h2 style={{ margin: 0, fontSize: "1.25rem", fontWeight: 700 }}>
          🏥 System Health
        </h2>
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          {(lastRefresh ?? lastFetchTime) && (
            <span style={{ fontSize: "0.8rem", color: "var(--color-text-muted, #6b7280)" }}>
              Updated {(lastRefresh ?? lastFetchTime)!.toLocaleTimeString()}
            </span>
          )}
          <button onClick={handleRefresh} className="btn btn-secondary" style={{ fontSize: "0.82rem", padding: "4px 12px" }}>
            ↻ Refresh
          </button>
        </div>
      </div>

      {error && (
        <div
          style={{
            padding: "10px 16px",
            borderRadius: "6px",
            background: "var(--color-warning-bg, #fef3c7)",
            color: "var(--color-warning, #92400e)",
            fontSize: "0.85rem",
            marginBottom: "16px",
          }}
          role="alert"
        >
          Last refresh failed: {error} — showing cached data.
        </div>
      )}

      {health && (
        <>
          <OverallBanner ok={health.ok} />

          {/* Component cards */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: "12px", marginBottom: "24px" }}>
            <ComponentCard title="Database" icon="🗄️" component={health.components.database} />
            <ComponentCard title="Horizon RPC" icon="🌐" component={health.components.horizon} />
            <ComponentCard title="Contract" icon="📜" component={health.components.contract} />
          </div>

          {/* Meta info */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: "8px 24px", fontSize: "0.85rem", color: "var(--color-text-muted, #6b7280)", marginBottom: "8px" }}>
            <span>Network: <strong style={{ color: "var(--color-text, #111827)" }}>{health.network}</strong></span>
            <span>DB version: <strong style={{ color: "var(--color-text, #111827)" }}>v{health.dbVersion}</strong></span>
            {health.contract.contractId && (
              <span>Contract: <strong style={{ color: "var(--color-text, #111827)", fontFamily: "monospace", fontSize: "0.8rem" }}>
                {health.contract.contractId.slice(0, 8)}…{health.contract.contractId.slice(-6)}
              </strong></span>
            )}
          </div>
        </>
      )}

      {/* SLA stats */}
      {sla && <SLASection sla={sla} />}

      {/* History table */}
      <div style={{ marginTop: "28px" }}>
        <h3 style={{ margin: "0 0 12px", fontSize: "1rem", fontWeight: 600 }}>
          🕐 History — last 24 hours
        </h3>
        <HistoryTable entries={history} />
      </div>
    </div>
  );
}
