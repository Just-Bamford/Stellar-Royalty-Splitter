import { useState, useEffect } from "react";
import { api, TransactionRecord } from "../api";
import "./TransactionHistory.css";

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

  useEffect(() => {
    fetchHistory();
  }, [contractId, offset]);

  const getStatusColor = (status: string) => {
    switch (status) {
      case "confirmed":
        return "#4ade80";
      case "failed":
        return "#f87171";
      default:
        return "#facc15";
    }
  };

  const formatDate = (dateString: string) => {
    try {
      return new Date(dateString).toLocaleString();
    } catch {
      return dateString;
    }
  };

  const truncateAddress = (address: string) => {
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
  };

  const truncateHash = (hash: string | null) => {
    if (!hash) return "Pending";
    return `${hash.slice(0, 8)}...${hash.slice(-8)}`;
  };

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
                  <tr key={tx.id}>
                    <td>
                      <span className="tx-type">{tx.type}</span>
                    </td>
                    <td title={tx.initiatorAddress}>
                      {truncateAddress(tx.initiatorAddress)}
                    </td>
                    <td>{tx.requestedAmount || "—"}</td>
                    <td title={tx.txHash || undefined} className="tx-hash-cell">
                      {truncateHash(tx.txHash)}
                    </td>
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
            <button
              onClick={() => setOffset(Math.max(0, offset - LIMIT))}
              disabled={offset === 0}
            >
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
    </div>
  );
};
