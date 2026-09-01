import { useState, useEffect } from "react";
import { api, TransactionRecord } from "../api";
import "./TransactionHistory.css";
import { formatNumber } from "../utils/format";
import { CopyButton } from "./CopyButton";
import { TransactionDetailView } from "./TransactionDetailView";
import { getStellarExpertTxUrl, formatTxHash } from "../lib/explorer";
import { useNetwork } from "../context/NetworkContext";
import { ListSkeleton } from "./Skeleton";
import { useTransactionHistory } from "../hooks/queries/useTransactionHistory";

interface TransactionHistoryProps {
  contractId: string;
  selectedTxHash?: string | null;
  onSelectTxHash?: (hash: string | null) => void;
}

interface HistoryFilters {
  type: "" | "distribute" | "initialize";
  recipient: string;
  startDate: string;
  endDate: string;
}

const DEFAULT_FILTERS: HistoryFilters = {
  type: "",
  recipient: "",
  startDate: "",
  endDate: "",
};

type SortField = "timestamp" | "amount" | "initiator";
type SortDirection = "asc" | "desc";

const CATEGORY_OPTIONS: { value: "" | "primary" | "secondary" | "batch"; label: string }[] = [
  { value: "", label: "All categories" },
  { value: "primary", label: "Primary" },
  { value: "secondary", label: "Secondary" },
  { value: "batch", label: "Batch" },
];

export const TransactionHistory: React.FC<TransactionHistoryProps> = ({
  contractId,
  selectedTxHash: propSelectedTxHash,
  onSelectTxHash,
}) => {
  const { network } = useNetwork();
  const [offset, setOffset] = useState(0);
  const [localSelectedTxHash, setLocalSelectedTxHash] = useState<string | null>(null);

  // Per-row "refresh status" state (#712): tracks which pending transaction's
  // status is currently being re-checked against Horizon, and surfaces the
  // outcome (or a friendly message when it's still not resolved) inline.
  const [refreshingTxHash, setRefreshingTxHash] = useState<string | null>(null);
  const [refreshMessage, setRefreshMessage] = useState<{ txHash: string; text: string } | null>(null);

  // Export panel state
  const [showExportPanel, setShowExportPanel] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportFilter, setExportFilter] = useState<{ startDate: string | null; endDate: string | null }>({
    startDate: null,
    endDate: null,
  });

  // Search / filter state
  const [filters, setFilters] = useState<HistoryFilters>(DEFAULT_FILTERS);
  const [pendingFilters, setPendingFilters] = useState<HistoryFilters>(DEFAULT_FILTERS);
  const [showFilterPanel, setShowFilterPanel] = useState(false);

  // Client-side search/token/category/sort (#754): applied in memory over the
  // fetched page, on top of the server-side date/type/recipient filters above.
  const [searchQuery, setSearchQuery] = useState("");
  const [tokenFilter, setTokenFilter] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<"" | "primary" | "secondary" | "batch">("");
  const [sortField, setSortField] = useState<SortField>("timestamp");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");

  const LIMIT = 10;

  const activeTxHash = propSelectedTxHash !== undefined ? propSelectedTxHash : localSelectedTxHash;

  // Build API filter object from current filter state
  const apiFilters = (() => {
    const f: Parameters<typeof api.getTransactionHistory>[3] = {};
    if (filters.type) f.type = filters.type as "distribute" | "initialize";
    if (filters.recipient) f.recipient = filters.recipient;
    if (filters.startDate) f.startDate = filters.startDate;
    if (filters.endDate) f.endDate = filters.endDate;
    return f;
  })();

  // React Query hook — automatically cached and deduplicated (#832)
  const {
    data: historyData,
    isLoading: loading,
    isFetching,
    isError,
    error: queryError,
    refetch,
  } = useTransactionHistory(contractId, LIMIT, offset, apiFilters);

  const transactions: TransactionRecord[] = historyData?.data ?? [];
  const total = historyData?.pagination?.total ?? 0;
  const error = isError ? (queryError as Error)?.message ?? "Failed to fetch history" : null;
  const refreshing = isFetching && !loading;

  const hasActiveFilters =
    filters.type !== "" ||
    filters.recipient !== "" ||
    filters.startDate !== "" ||
    filters.endDate !== "" ||
    searchQuery !== "" ||
    tokenFilter !== "" ||
    categoryFilter !== "";

  function handleSelectTxHash(hash: string | null) {
    if (onSelectTxHash) {
      onSelectTxHash(hash);
    } else {
      setLocalSelectedTxHash(hash);
    }
  }

  // #712: safely re-check a pending/delayed transaction's status against
  // Horizon. Never marks a transaction confirmed on the client's say-so —
  // the `status: "confirmed"` field below is ignored by the backend, which
  // derives the real outcome from polling Horizon itself (see
  // POST /transaction/confirm/:txHash); this call only asks it to look again.
  const handleRefreshStatus = async (tx: TransactionRecord) => {
    if (!tx.txHash || refreshingTxHash) return;
    setRefreshingTxHash(tx.txHash);
    setRefreshMessage(null);
    try {
      const result = await api.confirmTransaction(tx.txHash, {
        status: "confirmed",
        transactionId: tx.id,
      });
      setRefreshMessage({
        txHash: tx.txHash,
        text: result.message ?? "Status updated.",
      });
      // Refetch through the active query hook so the visible table updates immediately.
      void refetch();
    } catch (err) {
      // A failed refresh (including a Horizon polling timeout) means the
      // transaction's true status still isn't known — not that anything is
      // newly broken. Surface it as "still pending", not as an error.
      setRefreshMessage({
        txHash: tx.txHash,
        text: "Still pending — Horizon hasn't confirmed this yet. Try again shortly.",
      });
    } finally {
      setRefreshingTxHash(null);
    }
  };

  function applyFilters() {
    setFilters(pendingFilters);
    setOffset(0);
  }

  function resetFilters() {
    setPendingFilters(DEFAULT_FILTERS);
    setFilters(DEFAULT_FILTERS);
    setSearchQuery("");
    setTokenFilter("");
    setCategoryFilter("");
    setSortField("timestamp");
    setSortDirection("desc");
    setOffset(0);
  }

  const isBatch = (tx: TransactionRecord) => (tx.payoutCount ?? 0) > 1;
  const isSecondaryTx = (type: string) => type.startsWith("secondary_");

  function matchesCategory(tx: TransactionRecord, category: "" | "primary" | "secondary" | "batch") {
    if (!category) return true;
    if (category === "batch") return isBatch(tx);
    if (category === "secondary") return isSecondaryTx(tx.type);
    return !isSecondaryTx(tx.type);
  }

  function matchesSearch(tx: TransactionRecord, query: string) {
    if (!query) return true;
    const q = query.trim().toLowerCase();
    return (
      (tx.txHash ?? "").toLowerCase().includes(q) ||
      String(tx.id).toLowerCase().includes(q) ||
      tx.initiatorAddress.toLowerCase().includes(q)
    );
  }

  function matchesToken(tx: TransactionRecord, token: string) {
    if (!token) return true;
    return (tx.tokenId ?? "").toLowerCase().includes(token.trim().toLowerCase());
  }

  function sortTransactions(txs: TransactionRecord[]): TransactionRecord[] {
    const dir = sortDirection === "asc" ? 1 : -1;
    return [...txs].sort((a, b) => {
      if (sortField === "amount") {
        const av = Number(a.requestedAmount ?? 0);
        const bv = Number(b.requestedAmount ?? 0);
        return (av - bv) * dir;
      }
      if (sortField === "initiator") {
        return a.initiatorAddress.localeCompare(b.initiatorAddress) * dir;
      }
      return (new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()) * dir;
    });
  }

  const displayedTransactions = sortTransactions(
    transactions.filter(
      (tx) =>
        matchesCategory(tx, categoryFilter) &&
        matchesSearch(tx, searchQuery) &&
        matchesToken(tx, tokenFilter),
    ),
  );

  function filterByDateRange(
    txs: TransactionRecord[],
    f: { startDate: string | null; endDate: string | null },
  ): TransactionRecord[] {
    return txs.filter((tx) => {
      const ts = new Date(tx.timestamp).getTime();
      if (f.startDate && ts < new Date(f.startDate).getTime()) return false;
      if (f.endDate && ts > new Date(f.endDate + "T23:59:59").getTime()) return false;
      return true;
    });
  }

  function buildCSV(txs: TransactionRecord[]): string {
    const header = ["ID", "Type", "Initiator", "Amount", "TX Hash", "Status", "Timestamp"].join(",");
    const rows = txs.map((tx) =>
      [
        tx.id,
        tx.type,
        tx.initiatorAddress,
        tx.requestedAmount ?? "",
        tx.txHash ?? "",
        tx.status,
        tx.timestamp,
      ]
        .map((v) => `"${String(v).replace(/"/g, '""')}"`)
        .join(","),
    );
    return [header, ...rows].join("\n");
  }

  function downloadCSV(csv: string, filename: string) {
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  const handleExport = async () => {
    setExporting(true);
    try {
      const result = await api.getTransactionHistory(contractId, 10_000, 0);
      const all: TransactionRecord[] = result.data ?? [];
      const filtered = filterByDateRange(all, exportFilter);
      if (filtered.length === 0) {
        alert("No transactions found for the selected date range.");
        return;
      }
      const csv = buildCSV(filtered);
      const datePart = new Date().toISOString().split("T")[0];
      downloadCSV(csv, `transactions-${contractId.slice(0, 8)}-${datePart}.csv`);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Export failed");
    } finally {
      setExporting(false);
    }
  };

  // Reset offset when the contract changes
  useEffect(() => { setOffset(0); }, [contractId]);

  const TYPE_LABELS: Record<string, string> = {
    distribute: "Primary Distribution",
    secondary_royalty: "Secondary Royalty",
    secondary_distribute: "Secondary Distribution",
    initialize: "Initialization",
  };

  const isSecondary = (type: string) => type.startsWith("secondary_");

  const getTypeLabel = (type: string) => TYPE_LABELS[type] ?? type;

  // A pending transaction older than this is flagged "Delayed" rather than
  // shown identically to one submitted moments ago — Horizon polling on the
  // backend already gives up after its own timeout (see pollHorizonTransaction),
  // so a still-pending row this old likely needs a manual refresh or investigation.
  const DELAYED_PENDING_THRESHOLD_MS = 5 * 60 * 1000;

  const KNOWN_STATUSES = ["pending", "confirmed", "failed"] as const;

  function getStatusDisplay(tx: TransactionRecord): { label: string; color: string; textColor: string } {
    if (!KNOWN_STATUSES.includes(tx.status as (typeof KNOWN_STATUSES)[number])) {
      // Defensive: the API contract promises pending/confirmed/failed, but
      // don't let an unexpected value silently render as "pending" (yellow).
      return { label: "Unknown", color: "#94a3b8", textColor: "black" };
    }
    if (tx.status === "confirmed") return { label: "confirmed", color: "#4ade80", textColor: "black" };
    if (tx.status === "failed") return { label: "failed", color: "#f87171", textColor: "white" };

    const ageMs = Date.now() - new Date(tx.timestamp).getTime();
    if (Number.isFinite(ageMs) && ageMs > DELAYED_PENDING_THRESHOLD_MS) {
      return { label: "Delayed", color: "#fb923c", textColor: "black" };
    }
    return { label: "pending", color: "#facc15", textColor: "black" };
  }

  const formatDate = (dateString: string) => {
    try { return new Date(dateString).toLocaleString(); }
    catch { return dateString; }
  };

  const truncateAddress = (address: string) =>
    `${address.slice(0, 6)}...${address.slice(-4)}`;

  if (activeTxHash) {
    return (
      <TransactionDetailView
        txHash={activeTxHash}
        onBack={() => handleSelectTxHash(null)}
      />
    );
  }

  return (
    <div className="transaction-history">
      <div className="history-header">
        <h2>Transaction History</h2>
        <div className="history-header-actions">
          <button
            className="filter-toggle-btn"
            onClick={() => setShowFilterPanel((v) => !v)}
            aria-expanded={showFilterPanel}
          >
            {hasActiveFilters ? "Filters (active)" : "Filters"}
          </button>
          <button
            className="export-toggle-btn"
            onClick={() => setShowExportPanel((v) => !v)}
            aria-expanded={showExportPanel}
          >
            ↓ Export CSV
          </button>
          <button onClick={() => void refetch()} disabled={loading || refreshing}>
            {refreshing ? "Refreshing..." : "Refresh"}
          </button>
        </div>
      </div>

      {showFilterPanel && (
        <div className="filter-panel" role="search" aria-label="Filter transactions">
          <div className="filter-controls">
            <label className="filter-label">
              Recipient address
              <input
                type="text"
                className="filter-input"
                placeholder="Search by wallet address…"
                value={pendingFilters.recipient}
                onChange={(e) =>
                  setPendingFilters((f) => ({ ...f, recipient: e.target.value }))
                }
              />
            </label>

            <label className="filter-label">
              Type
              <select
                className="filter-select"
                value={pendingFilters.type}
                onChange={(e) =>
                  setPendingFilters((f) => ({
                    ...f,
                    type: e.target.value as HistoryFilters["type"],
                  }))
                }
              >
                <option value="">All types</option>
                <option value="distribute">Distribute</option>
                <option value="initialize">Initialize</option>
              </select>
            </label>

            <label className="filter-label">
              From
              <input
                type="date"
                className="filter-date-input"
                value={pendingFilters.startDate}
                onChange={(e) =>
                  setPendingFilters((f) => ({ ...f, startDate: e.target.value }))
                }
              />
            </label>

            <label className="filter-label">
              To
              <input
                type="date"
                className="filter-date-input"
                value={pendingFilters.endDate}
                onChange={(e) =>
                  setPendingFilters((f) => ({ ...f, endDate: e.target.value }))
                }
              />
            </label>

            <label className="filter-label">
              Category
              <select
                className="filter-select"
                value={categoryFilter}
                onChange={(e) =>
                  setCategoryFilter(e.target.value as typeof categoryFilter)
                }
              >
                {CATEGORY_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="filter-label">
              Token
              <input
                type="text"
                className="filter-input"
                placeholder="e.g. native, USDC…"
                value={tokenFilter}
                onChange={(e) => setTokenFilter(e.target.value)}
              />
            </label>

            <label className="filter-label">
              Search
              <input
                type="text"
                className="filter-input"
                placeholder="Transaction ID or collaborator address…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                aria-label="Search by transaction ID or collaborator address"
              />
            </label>

            <label className="filter-label">
              Sort by
              <select
                className="filter-select"
                value={sortField}
                onChange={(e) => setSortField(e.target.value as SortField)}
              >
                <option value="timestamp">Date</option>
                <option value="amount">Amount</option>
                <option value="initiator">Collaborator</option>
              </select>
            </label>

            <label className="filter-label">
              Direction
              <select
                className="filter-select"
                value={sortDirection}
                onChange={(e) => setSortDirection(e.target.value as SortDirection)}
              >
                <option value="desc">Descending</option>
                <option value="asc">Ascending</option>
              </select>
            </label>
          </div>

          <div className="filter-actions">
            <button className="filter-apply-btn" onClick={applyFilters} disabled={loading}>
              Apply filters
            </button>
            {hasActiveFilters && (
              <button className="filter-reset-btn" onClick={resetFilters}>
                Reset all filters
              </button>
            )}
          </div>
        </div>
      )}

      {showExportPanel && (
        <div className="export-panel">
          <div className="export-filters">
            <label className="export-label">
              From
              <input
                type="date"
                className="export-date-input"
                value={exportFilter.startDate ?? ""}
                onChange={(e) =>
                  setExportFilter((f) => ({ ...f, startDate: e.target.value || null }))
                }
              />
            </label>
            <label className="export-label">
              To
              <input
                type="date"
                className="export-date-input"
                value={exportFilter.endDate ?? ""}
                onChange={(e) =>
                  setExportFilter((f) => ({ ...f, endDate: e.target.value || null }))
                }
              />
            </label>
            <button
              className="export-btn"
              onClick={handleExport}
              disabled={exporting}
            >
              {exporting ? "Exporting…" : "Download CSV"}
            </button>
          </div>
          <p className="export-hint">
            Leave dates blank to export all transactions. Amounts are converted from stroops to XLM.
          </p>
        </div>
      )}

      {error && (
        <div className="error-message" role="alert" data-testid="history-error">
          <p>{error}</p>
          <button
            type="button"
            className="retry-btn"
            onClick={() => void refetch()}
            disabled={loading}
          >
            Retry
          </button>
        </div>
      )}

      {transactions.length === 0 && loading && (
        <>
          <span className="sr-only">Loading transactions…</span>
          <ListSkeleton items={5} label="Loading transactions…" />
        </>
      )}

      {transactions.length > 0 && displayedTransactions.length === 0 && !loading && (
        <div className="empty-state" data-testid="history-empty-state">
          No transactions match the active filters.
        </div>
      )}

      {transactions.length === 0 && !loading && (
        <div className="empty-state" data-testid="history-empty-state">
          {hasActiveFilters
            ? "No transactions match the active filters."
            : "No transactions yet"}
        </div>
      )}

      {transactions.length > 0 && displayedTransactions.length > 0 && (
        <>
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
                {displayedTransactions.map((tx) => (
                  <tr
                    key={tx.id}
                    className="tx-row-clickable"
                    onClick={() => tx.txHash && handleSelectTxHash(tx.txHash)}
                    title="Click to view details"
                  >
                    <td>
                      <span className={`tx-category ${isSecondary(tx.type) ? "tx-category-secondary" : "tx-category-primary"}`}>
                        {isSecondary(tx.type) ? "Secondary" : "Primary"}
                      </span>
                      <span className="tx-type">{getTypeLabel(tx.type)}</span>
                    </td>
                    <td title={tx.initiatorAddress}>{truncateAddress(tx.initiatorAddress)}</td>
                    <td>{tx.requestedAmount ? formatNumber(tx.requestedAmount) : "—"}</td>
                    <td
                      className="tx-hash-cell"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {tx.txHash ? (
                        <>
                          <a
                            href={getStellarExpertTxUrl(network, tx.txHash)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="tx-hash-link"
                            aria-label={`View transaction ${tx.txHash} on Stellar Expert`}
                            title={`View on Stellar Expert (${network})`}
                          >
                            {formatTxHash(tx.txHash)}
                          </a>
                          <CopyButton
                            value={tx.txHash}
                            label="transaction hash"
                            size="sm"
                          />
                        </>
                      ) : (
                        <span
                          className="tx-hash-pending"
                          aria-label="Transaction hash not yet available"
                        >
                          Pending
                        </span>
                      )}
                    </td>
                    <td onClick={(e) => e.stopPropagation()}>
                      {(() => {
                        const display = getStatusDisplay(tx);
                        const canRefresh = tx.status === "pending" && !!tx.txHash;
                        const isRefreshingThis = refreshingTxHash === tx.txHash;
                        return (
                          <div className="status-cell">
                            <span
                              className="status-badge"
                              style={{
                                backgroundColor: display.color,
                                color: display.textColor,
                              }}
                            >
                              {display.label}
                            </span>
                            {canRefresh && (
                              <button
                                type="button"
                                className="status-refresh-btn"
                                onClick={() => handleRefreshStatus(tx)}
                                disabled={isRefreshingThis}
                                aria-label={`Refresh status for transaction ${tx.txHash}`}
                              >
                                {isRefreshingThis ? "Checking…" : "Refresh status"}
                              </button>
                            )}
                            {refreshMessage && refreshMessage.txHash === tx.txHash && (
                              <span className="status-refresh-message" role="status">
                                {refreshMessage.text}
                              </span>
                            )}
                          </div>
                        );
                      })()}
                    </td>
                    <td>{formatDate(tx.timestamp)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

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

      {loading && transactions.length > 0 && (
        <div className="loading">Loading transactions...</div>
      )}
    </div>
  );
};
