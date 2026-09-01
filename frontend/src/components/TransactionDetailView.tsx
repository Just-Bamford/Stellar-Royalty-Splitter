import React, { useState, useEffect, useCallback } from "react";
import { api, TransactionDetails } from "../api";
import { CopyButton } from "./CopyButton";
import { getStellarExpertTxUrl, formatTxHash } from "../lib/explorer";
import "./TransactionDetailView.css";

interface TransactionDetailViewProps {
  txHash: string;
  onBack?: () => void;
  network?: "testnet" | "mainnet";
}

export const TransactionDetailView: React.FC<TransactionDetailViewProps> = ({
  txHash,
  onBack,
  network = "testnet",
}) => {
  const [details, setDetails] = useState<TransactionDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copiedLink, setCopiedLink] = useState(false);
  const [showRawEvents, setShowRawEvents] = useState(false);

  const fetchDetails = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.getTransactionDetails(txHash);
      if (res.success && res.data) {
        setDetails(res.data);
      } else {
        setError("Transaction not found");
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to fetch transaction details";
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [txHash]);

  useEffect(() => {
    fetchDetails();
  }, [fetchDetails]);

  function handleShareLink() {
    const shareUrl = `${window.location.origin}${window.location.pathname}?page=transactions&txHash=${txHash}`;
    navigator.clipboard.writeText(shareUrl);
    setCopiedLink(true);
    setTimeout(() => setCopiedLink(false), 2500);
  }

  if (loading) {
    return (
      <div className="tx-detail-container" data-testid="tx-detail-loading">
        <p>Loading transaction details for {formatTxHash(txHash)}...</p>
      </div>
    );
  }

  if (error || !details) {
    return (
      <div className="tx-detail-container" data-testid="tx-detail-error">
        <div className="tx-detail-header">
          {onBack && (
            <button type="button" className="tx-back-btn" onClick={onBack}>
              ← Back to History
            </button>
          )}
          <h2 className="tx-detail-title">Transaction Details</h2>
        </div>
        <div className="tx-toast error">
          <span>{error || "Transaction not found"}</span>
        </div>
      </div>
    );
  }

  const {
    contractId,
    type,
    initiatorAddress,
    requestedAmount,
    tokenId,
    timestamp,
    blockTime,
    status,
    errorMessage,
    payouts = [],
    totalPayout,
    auditHistory = [],
    contractEvents = [],
  } = details;

  const stellarExpertUrl = getStellarExpertTxUrl(network, txHash);

  return (
    <div className="tx-detail-container" data-testid="transaction-detail-view">
      {/* Header Bar */}
      <div className="tx-detail-header">
        <div className="tx-detail-header-left">
          {onBack && (
            <button type="button" className="tx-back-btn" onClick={onBack}>
              ← Back to List
            </button>
          )}
          <h2 className="tx-detail-title">
            <span>Transaction Details</span>
            <span className={`tx-status-badge ${status.toLowerCase()}`}>
              {status === "confirmed" ? "✅ Confirmed" : status === "pending" ? "⏳ Pending" : "❌ Failed"}
            </span>
          </h2>
        </div>

        <div className="tx-header-actions">
          <button
            type="button"
            className="tx-share-btn"
            onClick={handleShareLink}
            title="Copy pre-filled share link"
          >
            {copiedLink ? "✓ Link Copied" : "🔗 Share Link"}
          </button>
        </div>
      </div>

      {copiedLink && (
        <div className="tx-toast success">
          <span>Shareable URL pre-filled and copied to clipboard!</span>
        </div>
      )}

      {errorMessage && (
        <div className="tx-toast error" style={{ marginBottom: 20 }}>
          <span>Error: {errorMessage}</span>
        </div>
      )}

      {/* Metadata Overview Grid */}
      <div className="tx-metadata-grid">
        <div className="tx-meta-card">
          <div className="tx-meta-label">Transaction Hash</div>
          <div className="tx-meta-value">
            <a
              href={stellarExpertUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="tx-hash-link"
            >
              {formatTxHash(txHash)}
            </a>
            <CopyButton value={txHash} label="transaction hash" size="sm" />
          </div>
        </div>

        <div className="tx-meta-card">
          <div className="tx-meta-label">Contract ID</div>
          <div className="tx-meta-value">
            <span>
              {contractId
                ? `${contractId.substring(0, 8)}...${contractId.substring(contractId.length - 6)}`
                : "N/A"}
            </span>
            {contractId && <CopyButton value={contractId} label="contract ID" size="sm" />}
          </div>
        </div>

        <div className="tx-meta-card">
          <div className="tx-meta-label">Initiator Address</div>
          <div className="tx-meta-value">
            <span>
              {initiatorAddress
                ? `${initiatorAddress.substring(0, 8)}...${initiatorAddress.substring(initiatorAddress.length - 6)}`
                : "N/A"}
            </span>
            {initiatorAddress && <CopyButton value={initiatorAddress} label="initiator address" size="sm" />}
          </div>
        </div>

        <div className="tx-meta-card">
          <div className="tx-meta-label">Type & Asset</div>
          <div className="tx-meta-value">
            <span style={{ textTransform: "capitalize" }}>{type.replace("_", " ")}</span>
            <span style={{ color: "#6b7280" }}>({tokenId || "XLM"})</span>
          </div>
        </div>

        <div className="tx-meta-card">
          <div className="tx-meta-label">Total Amount</div>
          <div className="tx-meta-value">
            <strong>
              {requestedAmount || totalPayout || "0"} {tokenId || "XLM"}
            </strong>
          </div>
        </div>

        <div className="tx-meta-card">
          <div className="tx-meta-label">Timestamp / Block Time</div>
          <div className="tx-meta-value">
            <span>
              {new Date(blockTime || timestamp).toLocaleString()}
            </span>
          </div>
        </div>
      </div>

      {/* Recipients & Payouts Breakdown Table */}
      <div className="tx-detail-section">
        <h3 className="tx-section-title">
          👥 Recipients & Payout Breakdown ({payouts.length} Recipient{payouts.length === 1 ? "" : "s"})
        </h3>
        {payouts.length === 0 ? (
          <p style={{ color: "#6b7280", fontStyle: "italic" }}>
            No distribution payout records attached to this transaction.
          </p>
        ) : (
          <table className="tx-payouts-table">
            <thead>
              <tr>
                <th>Recipient Address</th>
                <th>Amount Received</th>
                <th>Share %</th>
              </tr>
            </thead>
            <tbody>
              {payouts.map((payout, idx) => {
                const share = payout.sharePercentage ?? 0;
                return (
                  <tr key={`${payout.collaboratorAddress}-${idx}`}>
                    <td>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span>
                          {payout.collaboratorAddress.substring(0, 8)}...
                          {payout.collaboratorAddress.substring(payout.collaboratorAddress.length - 6)}
                        </span>
                        <CopyButton
                          value={payout.collaboratorAddress}
                          label="collaborator address"
                          size="sm"
                        />
                      </div>
                    </td>
                    <td>
                      <strong>
                        {payout.amountReceived} {tokenId || "XLM"}
                      </strong>
                    </td>
                    <td>
                      <div className="tx-share-bar-container">
                        <div className="tx-share-bar-track">
                          <div
                            className="tx-share-bar-fill"
                            style={{ width: `${Math.min(100, Math.max(0, share))}%` }}
                          />
                        </div>
                        <span className="tx-share-percent-text">{share}%</span>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Audit Log / Edit History Section */}
      <div className="tx-detail-section">
        <h3 className="tx-section-title">
          📜 Audit Trail & Edit History ({auditHistory.length} Event{auditHistory.length === 1 ? "" : "s"})
        </h3>
        {auditHistory.length === 0 ? (
          <p style={{ color: "#6b7280", fontStyle: "italic" }}>
            No previous audit log records for this contract.
          </p>
        ) : (
          <div className="tx-audit-timeline">
            {auditHistory.map((item) => (
              <div key={item.id} className="tx-audit-item">
                <span className="tx-audit-icon">⚙️</span>
                <div className="tx-audit-content">
                  <div className="tx-audit-action">{item.action}</div>
                  <div className="tx-audit-user">
                    User: {item.user || "System"}
                    {item.details && typeof item.details === "object"
                      ? ` | ${JSON.stringify(item.details)}`
                      : ""}
                  </div>
                </div>
                <span className="tx-audit-time">
                  {new Date(item.timestamp).toLocaleString()}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Raw Contract Events Inspector */}
      <div className="tx-detail-section">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <h3 className="tx-section-title" style={{ margin: 0 }}>
            ⚡ Raw Soroban Contract Events ({contractEvents.length})
          </h3>
          <button
            type="button"
            className="tx-back-btn"
            onClick={() => setShowRawEvents(!showRawEvents)}
          >
            {showRawEvents ? "Hide Event Logs" : "Inspect Raw Event Payload"}
          </button>
        </div>

        {showRawEvents && (
          <div className="tx-events-inspector" data-testid="raw-contract-events">
            <pre className="tx-events-json">
              {JSON.stringify(contractEvents, null, 2)}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
};
