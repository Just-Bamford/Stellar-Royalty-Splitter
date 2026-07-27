import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { api } from "../api";
import { useSettings } from "../context/SettingsContext";
import { formatCurrency } from "../utils/format";
import {
  buildChartSeries,
  calculatePeriodSummary,
  fillMissingDays,
  filterEventsInRange,
  getRangeDates,
  type EarningsEvent,
  type EarningsTimeRange,
} from "../lib/earnings-history";
import { mergeSnapshots, readCachedSnapshots } from "../lib/earnings-snapshots-db";
import { DashboardSkeleton } from "./Skeleton";
import "./EarningsHistoryChart.css";

const RANGE_OPTIONS: Array<{ id: EarningsTimeRange; label: string }> = [
  { id: "7d", label: "7 days" },
  { id: "30d", label: "30 days" },
  { id: "90d", label: "90 days" },
  { id: "all", label: "All time" },
];

const CHART_COLORS = ["#667eea", "#22c55e", "#f59e0b", "#ef4444", "#06b6d4", "#a855f7"];

interface EarningsHistoryChartProps {
  walletAddress: string;
}

function shortContractId(contractId: string) {
  if (contractId.length <= 14) return contractId;
  return `${contractId.slice(0, 6)}…${contractId.slice(-4)}`;
}

export const EarningsHistoryChart: React.FC<EarningsHistoryChartProps> = ({ walletAddress }) => {
  const { settings } = useSettings();
  const [range, setRange] = useState<EarningsTimeRange>("30d");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [contracts, setContracts] = useState<string[]>([]);
  const [enabledContracts, setEnabledContracts] = useState<Set<string>>(new Set());
  const [events, setEvents] = useState<EarningsEvent[]>([]);
  const [snapshots, setSnapshots] = useState<
    Array<{ date: string; contractId: string; amount: number }>
  >([]);

  const loadHistory = useCallback(async () => {
    if (!walletAddress) {
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    setOffline(false);

    const { start, end } = getRangeDates(range);

    try {
      const response = await api.getEarningsHistory(walletAddress, { start, end });
      if (!response.success) {
        setError(response.message ?? "Failed to load earnings history");
        return;
      }

      const merged = await mergeSnapshots(walletAddress, response.data.snapshots);
      setSnapshots(merged);
      setEvents(response.data.events);
      setContracts(response.data.contracts);
      setEnabledContracts(new Set(response.data.contracts));
    } catch (err) {
      console.error("Earnings history fetch failed:", err);
      const cached = await readCachedSnapshots(walletAddress);
      if (cached.length > 0) {
        setSnapshots(cached);
        setOffline(true);
        setContracts(Array.from(new Set(cached.map((row) => row.contractId))));
        setEnabledContracts(new Set(cached.map((row) => row.contractId)));
      } else {
        setError("Unable to load earnings history. Check your connection and try again.");
      }
    } finally {
      setLoading(false);
    }
  }, [walletAddress, range]);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  const { start, end } = getRangeDates(range);
  const contractList = contracts.length > 0 ? contracts : Array.from(new Set(snapshots.map((row) => row.contractId)));
  const filledSnapshots = useMemo(
    () => fillMissingDays(snapshots, start, end, contractList),
    [snapshots, start, end, contractList],
  );
  const chartData = useMemo(
    () => buildChartSeries(filledSnapshots, enabledContracts),
    [filledSnapshots, enabledContracts],
  );
  const summary = useMemo(
    () => calculatePeriodSummary(filledSnapshots, range),
    [filledSnapshots, range],
  );
  const visibleEvents = useMemo(
    () => filterEventsInRange(events, start, end),
    [events, start, end],
  );

  function toggleContract(contractId: string) {
    setEnabledContracts((current) => {
      const next = new Set(current);
      if (next.has(contractId)) {
        next.delete(contractId);
      } else {
        next.add(contractId);
      }
      return next;
    });
  }

  if (!walletAddress) {
    return (
      <div className="earnings-history-empty">
        <h2>Connect your wallet</h2>
        <p>Connect a wallet to view your contributor earnings history.</p>
      </div>
    );
  }

  return (
    <div className="earnings-history">
      <header className="earnings-history-header">
        <div>
          <h1>Earnings History</h1>
          <p>Track daily earnings, compare periods, and spot payment gaps.</p>
        </div>
        <div className="earnings-range-selector" role="tablist" aria-label="Earnings time range">
          {RANGE_OPTIONS.map((option) => (
            <button
              key={option.id}
              type="button"
              role="tab"
              aria-selected={range === option.id}
              className={`range-btn${range === option.id ? " active" : ""}`}
              onClick={() => setRange(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </header>

      {offline && (
        <div className="earnings-offline-banner" role="status">
          Showing cached IndexedDB snapshots while offline.
        </div>
      )}

      {loading && <DashboardSkeleton />}

      {error && !loading && (
        <div className="earnings-error" role="alert">{error}</div>
      )}

      {!loading && !error && (
        <>
          <section className="earnings-summary" aria-label="Period summary">
            <div className="summary-card">
              <span className="summary-label">Period total</span>
              <strong>{formatCurrency(summary.total, settings.displayCurrency)}</strong>
            </div>
            <div className="summary-card">
              <span className="summary-label">Absolute change</span>
              <strong className={summary.absoluteChange >= 0 ? "positive" : "negative"}>
                {summary.absoluteChange >= 0 ? "+" : ""}
                {formatCurrency(summary.absoluteChange, settings.displayCurrency)}
              </strong>
            </div>
            <div className="summary-card">
              <span className="summary-label">Percent change</span>
              <strong className={summary.percentChange === null || summary.percentChange >= 0 ? "positive" : "negative"}>
                {summary.percentChange === null ? "N/A" : `${summary.percentChange >= 0 ? "+" : ""}${summary.percentChange}%`}
              </strong>
            </div>
          </section>

          {contractList.length > 0 && (
            <section className="contract-toggle-panel" aria-label="Contract visibility">
              {contractList.map((contractId, index) => (
                <label key={contractId} className="contract-toggle">
                  <input
                    type="checkbox"
                    checked={enabledContracts.has(contractId)}
                    onChange={() => toggleContract(contractId)}
                  />
                  <span
                    className="contract-swatch"
                    style={{ backgroundColor: CHART_COLORS[index % CHART_COLORS.length] }}
                    aria-hidden="true"
                  />
                  <span title={contractId}>{shortContractId(contractId)}</span>
                </label>
              ))}
            </section>
          )}

          <section className="earnings-chart-panel">
            {chartData.length === 0 ? (
              <div className="earnings-empty-state" role="status">
                <p>No earnings recorded for this period.</p>
                <p>Distributions will appear here once payouts are confirmed.</p>
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%" minHeight={280}>
                <LineChart data={chartData} margin={{ top: 12, right: 12, left: 0, bottom: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="date" tick={{ fontSize: 12 }} />
                  <YAxis tick={{ fontSize: 12 }} />
                  <Tooltip
                    formatter={(value: number | string) =>
                      typeof value === "number"
                        ? formatCurrency(value, settings.displayCurrency)
                        : value
                    }
                  />
                  <Legend />
                  {visibleEvents.map((event) => (
                    <ReferenceLine
                      key={`${event.type}-${event.contractId}-${event.date}`}
                      x={event.date.slice(0, 10)}
                      stroke={event.type === "distribution_failure" ? "#ef4444" : "#22c55e"}
                      strokeDasharray="4 4"
                      label={{ value: event.label, position: "insideTopLeft", fontSize: 10 }}
                    />
                  ))}
                  <Line
                    type="monotone"
                    dataKey="total"
                    name="Total earnings"
                    stroke="#111827"
                    strokeWidth={2}
                    dot={false}
                  />
                  {contractList
                    .filter((contractId) => enabledContracts.has(contractId))
                    .map((contractId, index) => (
                      <Line
                        key={contractId}
                        type="monotone"
                        dataKey={contractId}
                        name={shortContractId(contractId)}
                        stroke={CHART_COLORS[index % CHART_COLORS.length]}
                        strokeWidth={2}
                        dot={false}
                      />
                    ))}
                </LineChart>
              </ResponsiveContainer>
            )}
          </section>

          {visibleEvents.length > 0 && (
            <section className="earnings-events" aria-label="Earnings events">
              <h2>Events</h2>
              <ul>
                {visibleEvents.map((event) => (
                  <li key={`${event.type}-${event.contractId}-${event.date}`}>
                    <span className={`event-pill event-${event.type}`}>{event.label}</span>
                    <span>{new Date(event.date).toLocaleDateString()}</span>
                    <span title={event.contractId}>{shortContractId(event.contractId)}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
};
