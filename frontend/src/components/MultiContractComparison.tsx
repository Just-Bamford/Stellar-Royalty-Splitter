import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { formatCurrency } from "../utils/format";
import { useSettings } from "../context/SettingsContext";
import "./MultiContractComparison.css";

interface ComparisonRow {
  contractId: string;
  status: "loaded" | "error";
  totalDistributed: number;
  primaryTotal: number;
  secondaryTotal: number;
  collaboratorCount: number;
  errorMessage?: string;
}

interface MultiContractComparisonProps {
  contractIds: string[];
}

export function aggregateTotals(rows: ComparisonRow[]) {
  return rows
    .filter((r) => r.status === "loaded")
    .reduce(
      (acc, r) => ({
        totalDistributed: acc.totalDistributed + r.totalDistributed,
        primaryTotal: acc.primaryTotal + r.primaryTotal,
        secondaryTotal: acc.secondaryTotal + r.secondaryTotal,
      }),
      { totalDistributed: 0, primaryTotal: 0, secondaryTotal: 0 },
    );
}

function shortId(id: string) {
  return `${id.slice(0, 8)}…${id.slice(-6)}`;
}

export const MultiContractComparison: React.FC<MultiContractComparisonProps> = ({
  contractIds,
}) => {
  const { settings } = useSettings();
  const [rows, setRows] = useState<ComparisonRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (contractIds.length === 0) {
      setRows([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    // Fetch earnings analytics for every configured contract in parallel.
    // A failure on one contract must not block the others — we surface it
    // as a per-contract "unreachable" row instead of failing the view.
    const results = await Promise.allSettled(
      contractIds.map(async (contractId) => {
        const res = await api.getAnalytics(contractId);
        if (!res.success) {
          throw new Error(res.message || "Analytics unavailable");
        }
        return {
          contractId,
          status: "loaded" as const,
          totalDistributed: res.data.totalDistributed ?? 0,
          primaryTotal: res.data.primaryRoyaltiesTotal ?? 0,
          secondaryTotal: res.data.secondaryRoyaltiesTotal ?? 0,
          collaboratorCount: res.data.collaboratorStats?.length ?? 0,
        };
      }),
    );

    const nextRows: ComparisonRow[] = results.map((result, index) => {
      const contractId = contractIds[index];
      if (result.status === "fulfilled") {
        return result.value;
      }
      return {
        contractId,
        status: "error",
        totalDistributed: 0,
        primaryTotal: 0,
        secondaryTotal: 0,
        collaboratorCount: 0,
        errorMessage:
          result.reason instanceof Error
            ? result.reason.message
            : "Contract unreachable",
      };
    });

    setRows(nextRows);
    setLoading(false);
  }, [contractIds]);

  useEffect(() => {
    void load();
  }, [load]);

  const totals = useMemo(() => aggregateTotals(rows), [rows]);
  const failedCount = rows.filter((r) => r.status === "error").length;

  if (contractIds.length === 0) {
    return (
      <div className="mcc-empty" data-testid="comparison-empty">
        <p>
          No contracts tracked yet. Add contract IDs in Settings to compare
          earnings across projects.
        </p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="mcc-loading" data-testid="comparison-loading" aria-busy="true">
        Loading earnings for {contractIds.length} contract
        {contractIds.length === 1 ? "" : "s"}…
      </div>
    );
  }

  return (
    <div className="mcc" data-testid="multi-contract-comparison">
      <div className="mcc-header">
        <h2>All Contracts — Comparison &amp; Total</h2>
        <button
          type="button"
          className="refresh-dashboard-btn"
          onClick={() => void load()}
        >
          🔄 Refresh
        </button>
      </div>

      {failedCount > 0 && (
        <div className="mcc-warning" role="alert" data-testid="comparison-partial-error">
          ⚠️ {failedCount} contract{failedCount === 1 ? "" : "s"} could not be
          reached. Totals below only include reachable contracts.
        </div>
      )}

      {/* Aggregated totals across all reachable contracts */}
      <section className="kpi-grid mcc-totals" aria-label="Aggregated earnings across all contracts">
        <div className="kpi-card total-distributed-card">
          <div className="kpi-header">
            <span className="kpi-icon">💰</span>
            <span className="kpi-title">Total Earned (All)</span>
          </div>
          <div className="kpi-value" data-testid="total-all-distributed">
            {formatCurrency(totals.totalDistributed, settings.displayCurrency)}
          </div>
          <div className="kpi-subtext">Sum across all tracked contracts</div>
        </div>
        <div className="kpi-card primary-royalties-card">
          <div className="kpi-header">
            <span className="kpi-icon">✨</span>
            <span className="kpi-title">Primary (All)</span>
          </div>
          <div className="kpi-value" data-testid="total-all-primary">
            {formatCurrency(totals.primaryTotal, settings.displayCurrency)}
          </div>
        </div>
        <div className="kpi-card secondary-royalties-card">
          <div className="kpi-header">
            <span className="kpi-icon">🔄</span>
            <span className="kpi-title">Secondary (All)</span>
          </div>
          <div className="kpi-value" data-testid="total-all-secondary">
            {formatCurrency(totals.secondaryTotal, settings.displayCurrency)}
          </div>
        </div>
      </section>

      {/* Side-by-side comparison */}
      <div className="table-responsive">
        <table className="earnings-table mcc-table" data-testid="comparison-table">
          <thead>
            <tr>
              <th scope="col">Contract</th>
              <th scope="col" className="text-right">Total Distributed</th>
              <th scope="col" className="text-right">Primary</th>
              <th scope="col" className="text-right">Secondary</th>
              <th scope="col" className="text-right">Collaborators</th>
              <th scope="col" className="text-center">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.contractId}
                className={row.status === "error" ? "mcc-row-error" : ""}
              >
                <td className="address-cell" title={row.contractId}>
                  {shortId(row.contractId)}
                </td>
                <td className="text-right font-medium">
                  {row.status === "error"
                    ? "—"
                    : formatCurrency(row.totalDistributed, settings.displayCurrency)}
                </td>
                <td className="text-right">
                  {row.status === "error"
                    ? "—"
                    : formatCurrency(row.primaryTotal, settings.displayCurrency)}
                </td>
                <td className="text-right">
                  {row.status === "error"
                    ? "—"
                    : formatCurrency(row.secondaryTotal, settings.displayCurrency)}
                </td>
                <td className="text-right">
                  {row.status === "error" ? "—" : row.collaboratorCount}
                </td>
                <td className="text-center">
                  {row.status === "error" ? (
                    <span
                      className="status-pill status-failed"
                      title={row.errorMessage}
                      data-testid={`contract-error-${row.contractId}`}
                    >
                      Unreachable
                    </span>
                  ) : (
                    <span className="status-pill status-confirmed">OK</span>
                  )}
                </td>
              </tr>
            ))}
            <tr className="mcc-total-row">
              <td>Total ({rows.filter((r) => r.status === "loaded").length} contracts)</td>
              <td className="text-right font-medium">
                {formatCurrency(totals.totalDistributed, settings.displayCurrency)}
              </td>
              <td className="text-right">
                {formatCurrency(totals.primaryTotal, settings.displayCurrency)}
              </td>
              <td className="text-right">
                {formatCurrency(totals.secondaryTotal, settings.displayCurrency)}
              </td>
              <td colSpan={2} />
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default MultiContractComparison;
