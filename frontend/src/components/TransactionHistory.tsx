import { useState, useEffect } from "react";
import { api, TransactionRecord, TransactionDetails } from "../api";
import "./TransactionHistory.css";
import { formatNumber } from "../utils/format";

interface TransactionHistoryProps {
  contractId: string;
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
  const [copied, setCopied] = useState(false);
  const LIMIT = 10;

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

  const closeModal = () => { setSelected(null); setCopied(false); };

  const copyHash = async (hash: string) => {
    await navigator.clipboard.writeText(hash);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

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
                {transactions.map((tx) => (
                  <tr
                    key={tx.id}
                    className="tx-row-clickable"
                    onClick={() => openModal(tx)}
                    title="Click to view details"
                  >
                    <td><span className="tx-type">{tx.type}</span></td>
                    <td title={tx.initiatorAddress}>{truncateAddress(tx.initiatorAddress)}</td>
                    <td>{tx.requestedAmount ? formatNumber(tx.requestedAmount) : "—"}</td>
                    <td className="tx-hash-cell">{truncateHash(tx.txHash)}</td>
                    <td>
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
                    <button
                      className="tx-copy-btn"
                      onClick={() => copyHash(selected.txHash!)}
                      aria-label="Copy transaction hash"
                    >
                      {copied ? "✓ Copied" : "Copy"}
                    </button>
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
