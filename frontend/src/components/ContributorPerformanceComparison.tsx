import { useMemo, useState } from "react";
import type { CollaboratorEarning } from "./EarningsDashboard";
import { formatCurrency, formatNumber } from "../utils/format";
import "./ContributorPerformanceComparison.css";

const INACTIVE_AFTER_DAYS = 30;
type SortKey = "totalEarned" | "payoutCount" | "frequency" | "lastActivity";

type PerformanceRow = CollaboratorEarning & {
  frequency: number;
  inactive: boolean;
};

function activityDays(row: CollaboratorEarning, now: number): number {
  if (!row.lastActivity) return Number.POSITIVE_INFINITY;
  return Math.max(0, (now - new Date(row.lastActivity).getTime()) / 86_400_000);
}

export function buildPerformanceRows(rows: CollaboratorEarning[], now = Date.now()): PerformanceRow[] {
  return rows.map((row) => {
    const first = row.firstActivity ? new Date(row.firstActivity).getTime() : now;
    const last = row.lastActivity ? new Date(row.lastActivity).getTime() : now;
    const activeMonths = Math.max(1, (last - first) / 86_400_000 / 30);
    return {
      ...row,
      frequency: row.payoutCount / activeMonths,
      inactive: activityDays(row, now) > INACTIVE_AFTER_DAYS,
    };
  });
}

function compareRows(a: PerformanceRow, b: PerformanceRow, key: SortKey): number {
  if (key === "lastActivity") {
    return (b.lastActivity ?? "").localeCompare(a.lastActivity ?? "");
  }
  return b[key] - a[key];
}

interface ContributorPerformanceComparisonProps {
  collaborators: CollaboratorEarning[];
  currency: string;
}

export default function ContributorPerformanceComparison({
  collaborators,
  currency,
}: ContributorPerformanceComparisonProps) {
  const [sortKey, setSortKey] = useState<SortKey>("totalEarned");
  const rows = useMemo(
    () => buildPerformanceRows(collaborators).sort((a, b) => compareRows(a, b, sortKey)),
    [collaborators, sortKey],
  );
  const inactiveCount = rows.filter((row) => row.inactive).length;
  const bestEarner = rows[0];
  const averageFrequency = rows.length
    ? rows.reduce((sum, row) => sum + row.frequency, 0) / rows.length
    : 0;

  return (
    <section className="dashboard-section contributor-performance" aria-labelledby="contributor-performance-heading" data-testid="contributor-performance">
      <div className="section-header">
        <div>
          <h2 id="contributor-performance-heading">Contributor Performance Comparison</h2>
          <p className="section-sub">Compare who earns the most, how often distributions arrive, and who may need follow-up.</p>
        </div>
        <label className="performance-sort">
          <span>Sort by</span>
          <select value={sortKey} onChange={(event) => setSortKey(event.target.value as SortKey)} aria-label="Sort contributors by">
            <option value="totalEarned">Total earned</option>
            <option value="payoutCount">Distribution count</option>
            <option value="frequency">Payout frequency</option>
            <option value="lastActivity">Latest activity</option>
          </select>
        </label>
      </div>

      <div className="performance-summary" aria-label="Contributor performance summary">
        <div className="performance-stat">
          <span>Top earner</span>
          <strong data-testid="top-earner">{bestEarner ? `${bestEarner.address.slice(0, 8)}…` : "—"}</strong>
          <small>{bestEarner ? formatCurrency(bestEarner.totalEarned, currency) : "No payouts yet"}</small>
        </div>
        <div className="performance-stat">
          <span>Average frequency</span>
          <strong data-testid="average-frequency">{averageFrequency.toFixed(1)}</strong>
          <small>payouts per active month</small>
        </div>
        <div className="performance-stat performance-stat-alert">
          <span>Inactive contributors</span>
          <strong data-testid="inactive-count">{formatNumber(inactiveCount)}</strong>
          <small>No payout in the last {INACTIVE_AFTER_DAYS} days</small>
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="performance-empty">No contributor performance data is available yet.</p>
      ) : (
        <div className="table-responsive">
          <table className="earnings-table performance-table">
            <thead>
              <tr>
                <th scope="col">Contributor</th>
                <th scope="col" className="text-right">Total earned</th>
                <th scope="col" className="text-right">Distributions</th>
                <th scope="col" className="text-right">Frequency / month</th>
                <th scope="col">Last activity</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.address} data-testid={`performance-row-${row.address}`}>
                  <td className="address-cell" title={row.address}>{row.address.slice(0, 10)}…{row.address.slice(-6)}</td>
                  <td className="text-right font-medium">{formatCurrency(row.totalEarned, currency)}</td>
                  <td className="text-right">{formatNumber(row.payoutCount)}</td>
                  <td className="text-right">{row.frequency.toFixed(1)}</td>
                  <td>{row.lastActivity ? new Date(row.lastActivity).toLocaleDateString() : "No activity"}</td>
                  <td>
                    <span className={`performance-status ${row.inactive ? "inactive" : "active"}`}>
                      {row.inactive ? "Inactive" : "Active"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
