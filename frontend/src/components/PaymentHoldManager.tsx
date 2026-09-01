import { useState, useEffect } from "react";
import { api } from "../api";
import "./PaymentHoldManager.css";

interface HeldTransaction {
  id: number;
  txHash: string | null;
  contractId: string;
  type: string;
  initiatorAddress: string;
  requestedAmount: string | null;
  tokenId: string | null;
  status: string;
  hold_reason: string | null;
  hold_until: string | null;
  hold_placed_at: string | null;
  hold_placed_by: string | null;
  hold_released_at: string | null;
  hold_released_by: string | null;
  hold_approved_by: string | null;
  hold_approved_at: string | null;
  hold_approval_note: string | null;
  hold_status: string | null;
  timestamp: string;
  [key: string]: unknown;
}

interface PaymentHoldManagerProps {
  contractId: string;
  isAdmin?: boolean;
}

export function PaymentHoldManager({ contractId, isAdmin = false }: PaymentHoldManagerProps) {
  const [heldTxns, setHeldTxns] = useState<HeldTransaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedTxn, setSelectedTxn] = useState<HeldTransaction | null>(null);
  const [showReleaseModal, setShowReleaseModal] = useState(false);
  const [releaseNote, setReleaseNote] = useState("");

  useEffect(() => {
    loadHeldTransactions();
  }, [contractId]);

  const loadHeldTransactions = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.getHeldTransactions(contractId, "active");
      setHeldTxns(result.data as HeldTransaction[]);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load held transactions");
    } finally {
      setLoading(false);
    }
  };

  const handleApproveRelease = async (txn: HeldTransaction) => {
    setSelectedTxn(txn);
    setShowReleaseModal(true);
  };

  const handleConfirmRelease = async () => {
    if (!selectedTxn) return;
    setActionLoading(selectedTxn.id);
    try {
      await api.approveHoldRelease(selectedTxn.id, "admin", releaseNote);
      await api.releasePaymentHold(selectedTxn.id, "admin", releaseNote);
      setShowReleaseModal(false);
      setReleaseNote("");
      loadHeldTransactions();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to release hold");
    } finally {
      setActionLoading(null);
    }
  };

  const handlePlaceHold = async (transactionId: number, reason: string) => {
    setActionLoading(transactionId);
    try {
      await api.placePaymentHold(transactionId, reason, undefined, "admin");
      loadHeldTransactions();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to place hold");
    } finally {
      setActionLoading(null);
    }
  };

  const formatAddress = (addr: string) =>
    `${addr.slice(0, 6)}...${addr.slice(-4)}`;

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return "-";
    return new Date(dateStr).toLocaleString();
  };

  if (!isAdmin) {
    return (
      <div className="payment-hold-manager">
        <div className="hold-empty">Admin access required to manage payment holds.</div>
      </div>
    );
  }

  return (
    <div className="payment-hold-manager">
      <div className="hold-header">
        <h3>Payment Hold Management</h3>
        <button className="hold-refresh-btn" onClick={loadHeldTransactions}>
          Refresh
        </button>
      </div>

      {error && <div className="hold-error">{error}</div>}

      {loading ? (
        <div className="hold-loading">Loading held transactions...</div>
      ) : heldTxns.length === 0 ? (
        <div className="hold-empty">No transactions currently on hold.</div>
      ) : (
        <div className="hold-list">
          {heldTxns.map((txn) => (
            <div key={txn.id} className="hold-item">
              <div className="hold-item-header">
                <span className={`hold-status-badge ${txn.hold_status}`}>
                  {txn.hold_status === "active" ? "On Hold" : txn.hold_status}
                </span>
                <span className="hold-tx-type">{txn.type}</span>
              </div>
              <div className="hold-item-details">
                <div className="hold-detail">
                  <span className="hold-label">Transaction ID:</span>
                  <span className="hold-value">#{txn.id}</span>
                </div>
                {txn.txHash && (
                  <div className="hold-detail">
                    <span className="hold-label">Tx Hash:</span>
                    <code className="hold-value">{formatAddress(txn.txHash)}</code>
                  </div>
                )}
                <div className="hold-detail">
                  <span className="hold-label">Reason:</span>
                  <span className="hold-value">{txn.hold_reason || "No reason provided"}</span>
                </div>
                <div className="hold-detail">
                  <span className="hold-label">Placed By:</span>
                  <span className="hold-value">{txn.hold_placed_by || "Unknown"}</span>
                </div>
                <div className="hold-detail">
                  <span className="hold-label">Placed At:</span>
                  <span className="hold-value">{formatDate(txn.hold_placed_at)}</span>
                </div>
                {txn.hold_until && (
                  <div className="hold-detail">
                    <span className="hold-label">Hold Until:</span>
                    <span className="hold-value">{formatDate(txn.hold_until)}</span>
                  </div>
                )}
                <div className="hold-detail">
                  <span className="hold-label">Amount:</span>
                  <span className="hold-value">{txn.requestedAmount || "N/A"}</span>
                </div>
              </div>
              {txn.hold_status === "active" && (
                <div className="hold-item-actions">
                  {!txn.hold_approved_by ? (
                    <button
                      className="hold-action-btn approve"
                      onClick={() => handleApproveRelease(txn)}
                      disabled={actionLoading === txn.id}
                    >
                      {actionLoading === txn.id ? "Processing..." : "Approve & Release"}
                    </button>
                  ) : (
                    <span className="hold-approved-note">
                      Approved by {txn.hold_approved_by} - awaiting release
                    </span>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {showReleaseModal && selectedTxn && (
        <div className="hold-modal-overlay" onClick={() => setShowReleaseModal(false)}>
          <div className="hold-modal" onClick={(e) => e.stopPropagation()}>
            <div className="hold-modal-header">
              <h4>Release Payment Hold</h4>
              <button className="hold-modal-close" onClick={() => setShowReleaseModal(false)}>✕</button>
            </div>
            <div className="hold-modal-body">
              <p>Are you sure you want to release the hold on transaction <strong>#{selectedTxn.id}</strong>?</p>
              <div className="hold-modal-detail">
                <span>Reason for hold:</span>
                <strong>{selectedTxn.hold_reason}</strong>
              </div>
              <div className="hold-form-group">
                <label htmlFor="releaseNote">Release Note (optional)</label>
                <textarea
                  id="releaseNote"
                  value={releaseNote}
                  onChange={(e) => setReleaseNote(e.target.value)}
                  placeholder="Add a note about this release..."
                  rows={3}
                />
              </div>
            </div>
            <div className="hold-modal-footer">
              <button className="hold-modal-cancel" onClick={() => setShowReleaseModal(false)}>
                Cancel
              </button>
              <button
                className="hold-modal-confirm"
                onClick={handleConfirmRelease}
                disabled={actionLoading === selectedTxn.id}
              >
                {actionLoading === selectedTxn.id ? "Releasing..." : "Confirm Release"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
