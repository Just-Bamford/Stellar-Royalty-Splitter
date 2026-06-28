import { useState, useEffect, useMemo } from "react";
import { api, TransactionRecord, TransactionDetails } from "../api";
import "./TransactionHistory.css";
import { formatNumber } from "../utils/format";
import { CopyButton } from "./CopyButton";

interface TransactionHistoryProps {
  contractId: string;
}

type StatusFilter = "" | "pending" | "confirmed" | "failed";
type RangeFilter = "" | "7" | "30" | "90";

const RANGE_LABELS: Record<Exclude<RangeFilter, "">, string> = {
  "7": "Last 7 days",
  "30": "Last 30 days",
  "90": "Last 90 days",
};

function readParam(key: string): string {
  if (typeof window === "undefined") return "";
  return new URLSearchParams(window.location.search).get(key) ?? "";
}

export const TransactionHistory: React.FC<TransactionHistoryProps> = ({
  contractId,
}) => {
  const [transactions, setTransactions] = useState<TransactionRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState<TransactionDetails | null>(null);
  const [modalLoading, setModalLoading] = useState(false);
  const LIMIT = 10;

  // ─── Filters (#413) ──────────────────────────────────────────────────────
  const [search, setSearch] = useState(() => readParam("q"));
  const [debouncedSearch, setDebouncedSearch] = useState(() => readParam("q"));
  const [statusFilter, setStatusFilter] = useState<StatusFilter>(
    () => readParam("status") as StatusFilter,
  );
  const [initiatorFilter, setInitiatorFilter] = useState(() => readParam("initiator"));
  const [rangeFilter, setRangeFilter] = useState<RangeFilter>(
    () => readParam("range") as RangeFilter,
  );

  // Debounce the hash search (300ms) so we don't filter on every keystroke.
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  // Persist active filters in the URL query string.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const apply = (key: string, value: string) =>
      value ? params.set(key, value) : params.delete(key);
    apply("q", debouncedSearch);
    apply("status", statusFilter);
    apply("initiator", initiatorFilter);
    apply("range", rangeFilter);
    const qs = params.toString();
    window.history.replaceState(null, "", qs ? `?${qs}` : window.location.pathname);
  }, [debouncedSearch, statusFilter, initiatorFilter, rangeFilter]);

  // Initiator options come from the currently loaded transactions.
  const initiatorOptions = useMemo(() => {
    const seen = new Set<string>();
    for (const tx of transactions) seen.add(tx.initiatorAddress);
    return Array.from(seen);
  }, [transactions]);

  const filtered = useMemo(() => {
    const q = debouncedSearch.trim().toLowerCase();
    const days = rangeFilter ? Number(rangeFilter) : 0;
    const cutoff = days > 0 ? Date.now() - days * 86_400_000 : 0;
    return transactions.filter((tx) => {
      if (q && !(tx.txHash ?? "").toLowerCase().includes(q)) return false;
      if (statusFilter && tx.status !== statusFilter) return false;
      if (initiatorFilter && tx.initiatorAddress !== initiatorFilter) return false;
      if (cutoff && new Date(tx.timestamp).getTime() < cutoff) return false;
      return true;
    });
  }, [transactions, debouncedSearch, statusFilter, initiatorFilter, rangeFilter]);

  const hasActiveFilters = Boolean(
    debouncedSearch || statusFilter || initiatorFilter || rangeFilter,
  );

  const clearFilters = () => {
    setSearch("");
    setDebouncedSearch("");
    setStatusFilter("");
    setInitiatorFilter("");
    setRangeFilter("");
  };

  const fetchHistory = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.getTransactionHistory(contractId, LIMIT, offset);
      setTransactions(result.data || []);
      setTotal(result.pagination?.total ?? 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch history");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { setOffset(0); }, [contractId]);
  useEffect(() => { fetchHistory(); }, [contractId, offset]);

  const openModal = async (tx: TransactionRecord) => {
    if (!tx.txHash) {
      // No hash yet — show what we have without fetching details
      setSelected({ ...tx });
      return;
    }
    setModalLoading(true);
    setSelected({ ...tx }); // show immediately with basic data
    try {
      const result = await api.getTransactionDetails(tx.txHash);
      setSelected(result.data);
    } catch {
      // keep the basic data already shown
    } finally {
      setModalLoading(false);
    }
  };

  const closeModal = () => { setSelected(null); };

  const getStatusColor = (status: string) => {
    switch (status) {
      case "confirmed": return "#4ade80";
      case "failed":    return "#f87171";
      default:          return "#facc15";
    }
  };

  const formatDate = (dateString: string) => {
    try { return new Date(dateString).toLocaleString(); }
    catch { return dateString; }
  };

  const truncateAddress = (address: string) =>
    `${address.slice(0, 6)}...${address.slice(-4)}`;

  const truncateHash = (hash: string | null) =>
    hash ? `${hash.slice(0, 8)}...${hash.slice(-8)}` : "Pending";

  return (
    <div className="transaction-history">
      <div className="history-header">
        <h2>Transaction History</h2>
        <button onClick={fetchHistory} disabled={loading}>
          {loading ? "Refreshing..." : "Refresh"}
        </button>
      </div>

      {error && <div className="error-message">{error}</div>}

      {transactions.length === 0 && !loading && (
        <div className="empty-state">No transactions yet</div>
      )}

      {transactions.length > 0 && (
        <>
          <div className="tx-filters" role="search" aria-label="Filter transactions">
            <input
              type="text"
              className="tx-filter-search"
              placeholder="Search by transaction hash…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search by transaction hash"
            />
            <select
              className="tx-filter-select"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
              aria-label="Filter by status"
            >
              <option value="">All statuses</option>
              <option value="pending">Pending</option>
              <option value="confirmed">Confirmed</option>
              <option value="failed">Failed</option>
            </select>
            <select
              className="tx-filter-select"
              value={initiatorFilter}
              onChange={(e) => setInitiatorFilter(e.target.value)}
              aria-label="Filter by initiator"
            >
              <option value="">All initiators</option>
              {initiatorOptions.map((addr) => (
                <option key={addr} value={addr}>
                  {truncateAddress(addr)}
                </option>
              ))}
            </select>
            <select
              className="tx-filter-select"
              value={rangeFilter}
              onChange={(e) => setRangeFilter(e.target.value as RangeFilter)}
              aria-label="Filter by date range"
            >
              <option value="">All time</option>
              <option value="7">Last 7 days</option>
              <option value="30">Last 30 days</option>
              <option value="90">Last 90 days</option>
            </select>
            {hasActiveFilters && (
              <button type="button" className="tx-filter-clear" onClick={clearFilters}>
                Clear all
              </button>
            )}
          </div>

          {hasActiveFilters && (
            <div className="tx-filter-badges" aria-label="Active filters">
              {debouncedSearch && (
                <span className="tx-filter-badge">
                  Hash: {debouncedSearch}
                  <button type="button" aria-label="Clear hash filter" onClick={() => { setSearch(""); setDebouncedSearch(""); }}>×</button>
                </span>
              )}
              {statusFilter && (
                <span className="tx-filter-badge">
                  Status: {statusFilter}
                  <button type="button" aria-label="Clear status filter" onClick={() => setStatusFilter("")}>×</button>
                </span>
              )}
              {initiatorFilter && (
                <span className="tx-filter-badge">
                  Initiator: {truncateAddress(initiatorFilter)}
                  <button type="button" aria-label="Clear initiator filter" onClick={() => setInitiatorFilter("")}>×</button>
                </span>
              )}
              {rangeFilter && (
                <span className="tx-filter-badge">
                  {RANGE_LABELS[rangeFilter]}
                  <button type="button" aria-label="Clear date filter" onClick={() => setRangeFilter("")}>×</button>
                </span>
              )}
            </div>
          )}

          <div className="tx-result-count" data-testid="tx-result-count">
            {filtered.length} of {total} transactions
          </div>

          {filtered.length === 0 ? (
            <div className="empty-state">No transactions match your filters</div>
          ) : (
          <div className="transactions-table">
            <table>
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Initiator</th>
                  <th>Amount</th>
                  <th>TX Hash</th>
                  <th>Status</th>
                  <th>Timestamp</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((tx) => (
                  <tr
                    key={tx.id}
                    className="tx-row-clickable"
                    onClick={() => openModal(tx)}
                    title="Click to view details"
                  >
                    <td data-label="Type"><span className="tx-type">{tx.type}</span></td>
                    <td data-label="Initiator" title={tx.initiatorAddress}>{truncateAddress(tx.initiatorAddress)}</td>
                    <td data-label="Amount">{tx.requestedAmount ? formatNumber(tx.requestedAmount) : "—"}</td>
                    <td
                      className="tx-hash-cell"
                      data-label="TX Hash"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <span className="tx-hash-text">{truncateHash(tx.txHash)}</span>
                      {tx.txHash && (
                        <CopyButton
                          value={tx.txHash}
                          label="transaction hash"
                          size="sm"
                        />
                      )}
                    </td>
                    <td data-label="Status">
                      <span
                        className="status-badge"
                        style={{
                          backgroundColor: getStatusColor(tx.status),
                          color: tx.status === "failed" ? "white" : "black",
                        }}
                      >
                        {tx.status}
                      </span>
                    </td>
                    <td data-label="Timestamp">{formatDate(tx.timestamp)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          )}

          <div className="pagination">
            <button onClick={() => setOffset(Math.max(0, offset - LIMIT))} disabled={offset === 0}>
              Previous
            </button>
            <span>
              Showing {offset + 1}–{offset + transactions.length} of {total} transactions
            </span>
            <button
              onClick={() => setOffset(offset + LIMIT)}
              disabled={offset + transactions.length >= total}
            >
              Next
            </button>
          </div>
        </>
      )}

      {loading && <div className="loading">Loading transactions...</div>}

      {/* Detail modal */}
      {selected && (
        <div className="tx-modal-overlay" onClick={closeModal} role="dialog" aria-modal="true" aria-label="Transaction details">
          <div className="tx-modal" onClick={(e) => e.stopPropagation()}>
            <div className="tx-modal-header">
              <h3>Transaction Details</h3>
              <button className="tx-modal-close" onClick={closeModal} aria-label="Close">✕</button>
            </div>

            <div className="tx-modal-body">
              <div className="tx-detail-row">
                <span className="tx-detail-label">Type</span>
                <span className="tx-type">{selected.type}</span>
              </div>

              <div className="tx-detail-row">
                <span className="tx-detail-label">Status</span>
                <span
                  className="status-badge"
                  style={{
                    backgroundColor: getStatusColor(selected.status),
                    color: selected.status === "failed" ? "white" : "black",
                  }}
                >
                  {selected.status}
                </span>
              </div>

              <div className="tx-detail-row">
                <span className="tx-detail-label">TX Hash</span>
                <span className="tx-detail-hash">
                  <span className="tx-detail-mono">{selected.txHash ?? "Pending"}</span>
                  {selected.txHash && (
                    <CopyButton
                      value={selected.txHash}
                      label="transaction hash"
                      size="sm"
                    />
                  )}
                </span>
              </div>

              <div className="tx-detail-row">
                <span className="tx-detail-label">Initiator</span>
                <span className="tx-detail-mono">{selected.initiatorAddress}</span>
              </div>

              <div className="tx-detail-row">
                <span className="tx-detail-label">Timestamp</span>
                <span>{formatDate(selected.timestamp)}</span>
              </div>

              {selected.requestedAmount && (
                <div className="tx-detail-row">
                  <span className="tx-detail-label">Amount</span>
                  <span>{formatNumber(selected.requestedAmount)}</span>
                </div>
              )}

              {selected.tokenId && (
                <div className="tx-detail-row">
                  <span className="tx-detail-label">Token</span>
                  <span className="tx-detail-mono">{selected.tokenId}</span>
                </div>
              )}

              {selected.status === "failed" && selected.errorMessage && (
                <div className="tx-detail-row tx-detail-error">
                  <span className="tx-detail-label">Error</span>
                  <span className="tx-error-text">{selected.errorMessage}</span>
                </div>
              )}

              {modalLoading && (
                <div className="tx-modal-loading">Loading payout details…</div>
              )}

              {!modalLoading && selected.payouts && selected.payouts.length > 0 && (
                <div className="tx-payouts">
                  <span className="tx-detail-label">Payouts</span>
                  <table className="tx-payouts-table">
                    <thead>
                      <tr><th>Collaborator</th><th>Amount</th></tr>
                    </thead>
                    <tbody>
                      {selected.payouts.map((p, i) => (
                        <tr key={i}>
                          <td className="tx-detail-mono">{p.collaboratorAddress}</td>
                          <td>{formatNumber(p.amountReceived)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
