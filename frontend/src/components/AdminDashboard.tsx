import { useState, useEffect } from "react";
import { api, TransactionRecord } from "../api";
import { QRCodeSVG } from "qrcode.react";
import "./AdminDashboard.css";

interface AdminDashboardProps {
  contractId: string;
}

export const AdminDashboard: React.FC<AdminDashboardProps> = ({
  contractId,
}) => {
  const [showModal, setShowModal] = useState(false);
  const [showQRModal, setShowQRModal] = useState(false);
  const [copied, setCopied] = useState(false);
  const [shareLinkCopied, setShareLinkCopied] = useState(false);
  const [initHistory, setInitHistory] = useState<TransactionRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [contractVersion, setContractVersion] = useState<string>("loading...");

  useEffect(() => {
    if (contractId) {
      loadInitializeHistory();
      loadContractVersion();
    }
  }, [contractId]);

  const loadInitializeHistory = async () => {
    setLoading(true);
    try {
      const response = await api.getTransactionHistory(contractId, 50, 0);
      if (response.data) {
        // Filter only initialize transactions
        const initTransactions = response.data.filter(
          (t) => t.type === "initialize",
        );
        setInitHistory(initTransactions);
      }
    } catch (err) {
      console.error("Error loading initialize history:", err);
    } finally {
      setLoading(false);
    }
  };

  const loadContractVersion = async () => {
    try {
      const response = await api.getContractVersion(contractId);
      setContractVersion(response.version);
    } catch (err: any) {
      console.error("Error loading contract version:", err);
      // Check if it's a "not initialized" error from backend
      if (err.message?.includes('404') || err.message?.includes('not initialized')) {
        setContractVersion("not initialized");
      } else {
        setContractVersion("unknown");
      }
    }
  };

  const copyToClipboard = () => {
    navigator.clipboard.writeText(contractId);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const exportContractInfo = () => {
    const contractInfo = {
      contractId,
      version: contractVersion,
      network: "Stellar Testnet",
      runtime: "Soroban",
      exportedAt: new Date().toISOString(),
      features: [
        "Automated Revenue Distribution",
        "Multi-Collaborator Support",
        "Transaction Audit Trail",
        "Secondary Royalty Management",
        "Real-time Analytics"
      ]
    };

    const blob = new Blob([JSON.stringify(contractInfo, null, 2)], {
      type: "application/json"
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `contract-${contractId.slice(0, 8)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const generateShareLink = () => {
    const shareUrl = `${window.location.origin}${window.location.pathname}?contract=${contractId}`;
    navigator.clipboard.writeText(shareUrl);
    setShareLinkCopied(true);
    setTimeout(() => setShareLinkCopied(false), 2000);
  };

  if (!contractId) {
    return (
      <div className="admin-empty">
        <p>No contract selected</p>
      </div>
    );
  }

  return (
    <div className="admin-dashboard">
      <div className="admin-header">
        <h1>⚙️ Admin Dashboard</h1>
      </div>

      {/* Contract Info Card */}
      <div className="contract-card">
        <div className="contract-header">
          <h2>Contract Information</h2>
          <button className="info-btn" onClick={() => setShowModal(true)}>
            ℹ️ Details
          </button>
        </div>

        <div className="contract-id-display">
          <div className="contract-id-label">Contract ID</div>
          <div className="contract-id-value">
            <code>{contractId}</code>
            <button
              className={`copy-btn ${copied ? "copied" : ""}`}
              onClick={copyToClipboard}
              title="Copy to clipboard"
            >
              {copied ? "✓ Copied" : "📋 Copy"}
            </button>
          </div>
        </div>

        <div className="contract-actions">
          <button className="action-btn export" onClick={exportContractInfo} title="Export contract info as JSON">
            📥 Export
          </button>
          <button 
            className={`action-btn share ${shareLinkCopied ? "copied" : ""}`}
            onClick={generateShareLink}
            title="Generate shareable link"
          >
            {shareLinkCopied ? "✓ Link Copied" : "🔗 Share"}
          </button>
          <button className="action-btn qr" onClick={() => setShowQRModal(true)} title="Show QR code">
            📱 QR Code
          </button>
        </div>

        <div className="contract-version-display">
          <div className="contract-version-label">Contract Version</div>
          <div className="contract-version-value">
            <code>v{contractVersion}</code>
          </div>
        </div>

        <div className="contract-stats">
          <div className="stat">
            <span className="stat-label">Network</span>
            <span className="stat-value">Stellar Testnet</span>
          </div>
          <div className="stat">
            <span className="stat-label">Runtime</span>
            <span className="stat-value">Soroban</span>
          </div>
          <div className="stat">
            <span className="stat-label">Status</span>
            <span className="stat-value active">Active</span>
          </div>
        </div>
      </div>

      {/* Initialize History */}
      <div className="history-section">
        <div className="history-header">
          <h2>Initialize History</h2>
          <button onClick={loadInitializeHistory} className="refresh-mini-btn">
            🔄
          </button>
        </div>

        {loading ? (
          <div className="loading-mini">Loading...</div>
        ) : initHistory.length > 0 ? (
          <div className="history-list">
            {initHistory.map((record, idx) => (
              <div key={idx} className="history-item">
                <div className="history-timestamp">
                  {new Date(record.timestamp).toLocaleString()}
                </div>
                <div className="history-details">
                  <div className="detail-row">
                    <span className="label">Initiator:</span>
                    <code className="value">
                      {record.initiatorAddress.slice(0, 10)}...
                      {record.initiatorAddress.slice(-6)}
                    </code>
                  </div>
                  <div className="detail-row">
                    <span className="label">Status:</span>
                    <span className={`status ${record.status}`}>
                      {record.status}
                    </span>
                  </div>
                  {record.txHash && (
                    <div className="detail-row">
                      <span className="label">TX Hash:</span>
                      <code className="value tx-hash">
                        {record.txHash.slice(0, 16)}...
                      </code>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="no-history">No initialize records found</div>
        )}
      </div>

      {/* Contract Info Modal */}
      {showModal && (
        <div className="modal-overlay" onClick={() => setShowModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Contract Details</h2>
              <button
                className="modal-close"
                onClick={() => setShowModal(false)}
              >
                ✕
              </button>
            </div>

            <div className="modal-content">
              <div className="detail-block">
                <h3>Contract ID</h3>
                <div className="contract-info-block">
                  <code>{contractId}</code>
                  <button onClick={copyToClipboard} className="copy-modal-btn">
                    📋 Copy
                  </button>
                </div>
              </div>

              <div className="detail-block">
                <h3>Contract Version</h3>
                <div className="version-info-block">
                  <code>v{contractVersion}</code>
                </div>
              </div>

              <div className="detail-block">
                <h3>Network Information</h3>
                <div className="info-grid">
                  <div className="info-item">
                    <span className="info-label">Network</span>
                    <span className="info-value">Stellar Testnet</span>
                  </div>
                  <div className="info-item">
                    <span className="info-label">Blockchain</span>
                    <span className="info-value">Stellar</span>
                  </div>
                  <div className="info-item">
                    <span className="info-label">Runtime</span>
                    <span className="info-value">Soroban</span>
                  </div>
                  <div className="info-item">
                    <span className="info-label">Status</span>
                    <span className="info-value active">Active</span>
                  </div>
                </div>
              </div>

              <div className="detail-block">
                <h3>Smart Contract Features</h3>
                <ul className="features-list">
                  <li>✓ Automated Revenue Distribution</li>
                  <li>✓ Multi-Collaborator Support</li>
                  <li>✓ Transaction Audit Trail</li>
                  <li>✓ Secondary Royalty Management</li>
                  <li>✓ Real-time Analytics</li>
                </ul>
              </div>

              <div className="detail-block">
                <h3>Resources</h3>
                <div className="resources-links">
                  <a
                    href="https://stellar.org/docs"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    📖 Stellar Docs
                  </a>
                  <a
                    href="https://soroban.stellar.org"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    🚀 Soroban Runtime
                  </a>
                  <a
                    href="https://testnet.stellar.expert"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    🔍 Stellar Expert
                  </a>
                </div>
              </div>
            </div>

            <div className="modal-footer">
              <button className="btn-close" onClick={() => setShowModal(false)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* QR Code Modal */}
      {showQRModal && (
        <div className="modal-overlay" onClick={() => setShowQRModal(false)}>
          <div className="modal qr-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Contract QR Code</h2>
              <button
                className="modal-close"
                onClick={() => setShowQRModal(false)}
              >
                ✕
              </button>
            </div>

            <div className="modal-content qr-content">
              <div className="qr-code-container">
                <QRCodeSVG 
                  value={contractId} 
                  size={256}
                  level="H"
                  includeMargin={true}
                />
              </div>
              <div className="qr-info">
                <p>Scan this QR code to share the contract ID</p>
                <code className="qr-contract-id">{contractId}</code>
              </div>
            </div>

            <div className="modal-footer">
              <button className="btn-close" onClick={() => setShowQRModal(false)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
