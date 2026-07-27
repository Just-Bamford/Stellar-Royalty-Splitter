import { useState, useEffect, useCallback } from "react";
import { api } from "../api";
import { formatCurrency } from "../utils/format";
import { useSettings } from "../context/SettingsContext";
import "./MultiContractEarnings.css";

type EarningsData = Awaited<ReturnType<typeof api.getMultiContractEarnings>>;

interface MultiContractEarningsProps {
  walletAddress: string;
}

function formatContractId(id: string) {
  return `${id.slice(0, 8)}…${id.slice(-6)}`;
}

export function MultiContractEarnings({ walletAddress }: MultiContractEarningsProps) {
  const { settings } = useSettings();
  const [data, setData] = useState<EarningsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [allTime, setAllTime] = useState(true);
  const [dateRange, setDateRange] = useState({
    start: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split("T")[0],
    end: new Date().toISOString().split("T")[0],
  });

  const load = useCallback(async () => {
    if (!walletAddress) return;
    setLoading(true);
    setError(null);
    try {
      const result = await api.getMultiContractEarnings(
        walletAddress,
        allTime ? undefined : { start: dateRange.start, end: dateRange.end },
      );
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load earnings");
    } finally {
      setLoading(false);
    }
  }, [walletAddress, allTime, dateRange]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!walletAddress) {
    return (
      <div className="mce-empty">
        <p>Connect your wallet to view earnings across contracts.</p>
      </div>
    );
  }

  return (
    <div className="mce">
      <div className="mce-header">
        <div>
          <h2 className="mce-title">Multi-Contract Earnings</h2>
          <p className="mce-subtitle">
            Total earnings for{" "}
            <code className="mce-address">
              {walletAddress.slice(0, 8)}…{walletAddress.slice(-6)}
            </code>
          </p>
        </div>
        <div className="mce-toolbar">
          <button
            type="button"
            className={`mce-preset-btn${allTime ? " active" : ""}`}
            aria-pressed={allTime}
            onClick={() => setAllTime(true)}
          >
            All time
          </button>
          <button
            type="button"
            className={`mce-preset-btn${!allTime ? " active" : ""}`}
            aria-pressed={!allTime}
            onClick={() => setAllTime(false)}
          >
            Custom range
          </button>
          {!allTime && (
            <div className="mce-date-range">
              <label className="sr-only" htmlFor="mce-start">Start</label>
              <input
                id="mce-start"
                type="date"
                value={dateRange.start}
                max={dateRange.end}
                onChange={(e) => setDateRange((r) => ({ ...r, start: e.target.value }))}
              />
              <span aria-hidden="true">–</span>
              <label className="sr-only" htmlFor="mce-end">End</label>
              <input
                id="mce-end"
                type="date"
                value={dateRange.end}
                min={dateRange.start}
                max={new Date().toISOString().split("T")[0]}
                onChange={(e) => setDateRange((r) => ({ ...r, end: e.target.value }))}
              />
            </div>
          )}
          <button
            type="button"
            className="mce-refresh-btn"
            onClick={() => void load()}
            disabled={loading}
          >
            {loading ? "…" : "↺"}
          </button>
        </div>
      </div>

      {error && (
        <div className="mce-error" role="alert">{error}</div>
      )}

      {loading && !data && (
        <div className="mce-loading" aria-busy="true">Loading earnings…</div>
      )}

      {data && (
        <>
          {/* Summary KPIs */}
          <div className="mce-kpis">
            <div className="mce-kpi">
              <div className="mce-kpi-label">Total Earned</div>
              <div className="mce-kpi-value">
                {formatCurrency(data.data.summary.totalEarned, settings.displayCurrency)}
              </div>
            </div>
            <div className="mce-kpi">
              <div className="mce-kpi-label">Contracts</div>
              <div className="mce-kpi-value">{data.data.summary.contractCount}</div>
            </div>
            <div className="mce-kpi">
              <div className="mce-kpi-label">Total Payouts</div>
              <div className="mce-kpi-value">{data.data.summary.totalPayouts.toLocaleString()}</div>
            </div>
            <div className="mce-kpi">
              <div className="mce-kpi-label">Avg per Contract</div>
              <div className="mce-kpi-value">
                {formatCurrency(data.data.summary.avgPerContract, settings.displayCurrency)}
              </div>
            </div>
          </div>

          {/* Per-contract breakdown */}
          {data.data.contracts.length === 0 ? (
            <div className="mce-empty-contracts">No earnings found for this period.</div>
          ) : (
            <div className="mce-table-wrapper">
              <table className="mce-table">
                <thead>
                  <tr>
                    <th scope="col">Contract</th>
                    <th scope="col" className="text-right">Total Earned</th>
                    <th scope="col" className="text-right">Payouts</th>
                    <th scope="col" className="text-right">Avg Payout</th>
                    <th scope="col" className="text-right">Share</th>
                    <th scope="col" className="text-right">Last Activity</th>
                  </tr>
                </thead>
                <tbody>
                  {data.data.contracts.map((c) => (
                    <tr key={c.contractId}>
                      <td className="mce-contract-cell" title={c.contractId}>
                        <code>{formatContractId(c.contractId)}</code>
                      </td>
                      <td className="text-right">
                        {formatCurrency(c.totalEarned, settings.displayCurrency)}
                      </td>
                      <td className="text-right">{c.payoutCount.toLocaleString()}</td>
                      <td className="text-right">
                        {formatCurrency(c.avgPayout, settings.displayCurrency)}
                      </td>
                      <td className="text-right">
                        <div className="mce-share-bar-wrap">
                          <span className="mce-share-pct">{c.share.toFixed(1)}%</span>
                          <div className="mce-share-bar" role="presentation">
                            <div
                              className="mce-share-bar-fill"
                              style={{ width: `${Math.min(c.share, 100)}%` }}
                            />
                          </div>
                        </div>
                      </td>
                      <td className="text-right">
                        {c.lastActivity
                          ? new Date(c.lastActivity).toLocaleDateString()
                          : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
