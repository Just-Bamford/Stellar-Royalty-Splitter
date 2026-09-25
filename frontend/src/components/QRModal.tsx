/**
 * QR Code modal component for WalletConnect — closes #942.
 *
 * Displays a QR code that mobile wallet apps can scan to establish a
 * WalletConnect session. Designed to be simple, focused, and aligned
 * with the project's theme.
 */

import React, { useEffect, useState } from "react";
import QRCode from "qrcode.react";
import "./QRModal.css";

interface QRModalProps {
  /** QR code URI from WalletConnect provider */
  uri: string | null;
  /** Loading state (while waiting for QR URI) */
  isLoading?: boolean;
  /** Error message if connection failed */
  error?: string | null;
  /** Callback when user dismisses the modal */
  onClose: () => void;
  /** Callback when session is established (address returned) */
  onConnect?: (address: string) => void;
  /** Wallet name for display (e.g. "WalletConnect") */
  walletName?: string;
}

/**
 * Modal that displays a WalletConnect QR code.
 * User scans with mobile wallet to establish session.
 */
export const QRModal: React.FC<QRModalProps> = ({
  uri,
  isLoading = false,
  error = null,
  onClose,
  onConnect,
  walletName = "WalletConnect",
}) => {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (copied) {
      const timer = setTimeout(() => setCopied(false), 2000);
      return () => clearTimeout(timer);
    }
  }, [copied]);

  const copyToClipboard = () => {
    if (uri) {
      navigator.clipboard.writeText(uri);
      setCopied(true);
    }
  };

  return (
    <div className="qr-modal-overlay">
      <div className="qr-modal-content">
        {/* Header */}
        <div className="qr-modal-header">
          <h2>Connect with {walletName}</h2>
          <button className="qr-modal-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        {/* Body */}
        <div className="qr-modal-body">
          {error ? (
            // Error state
            <div className="qr-modal-error">
              <div className="qr-modal-error-icon">⚠️</div>
              <p>{error}</p>
              <button className="qr-modal-button" onClick={onClose}>
                Try Again
              </button>
            </div>
          ) : isLoading ? (
            // Loading state
            <div className="qr-modal-loading">
              <div className="spinner"></div>
              <p>Preparing QR code...</p>
            </div>
          ) : uri ? (
            // QR code display
            <div className="qr-modal-qr-container">
              <p className="qr-modal-instruction">
                Scan this QR code with your mobile wallet or hardware wallet app
              </p>
              <div className="qr-code-wrapper">
                <QRCode
                  value={uri}
                  size={256}
                  level="H"
                  includeMargin={true}
                  renderAs="canvas"
                />
              </div>
              <p className="qr-modal-subtext">
                After scanning, confirm the connection on your mobile device
              </p>

              {/* Fallback manual entry */}
              <details className="qr-modal-fallback">
                <summary>Can't scan? Copy the connection link</summary>
                <div className="qr-modal-manual">
                  <code className="uri-code">{uri}</code>
                  <button className="qr-modal-copy-button" onClick={copyToClipboard}>
                    {copied ? "✓ Copied" : "Copy Link"}
                  </button>
                </div>
              </details>
            </div>
          ) : (
            // Idle state (shouldn't happen in normal flow)
            <div className="qr-modal-idle">
              <p>No QR code available</p>
              <button className="qr-modal-button" onClick={onClose}>
                Close
              </button>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="qr-modal-footer">
          <p className="qr-modal-security-note">
            🔒 Your private keys never leave your device. This is just a connection link.
          </p>
        </div>
      </div>
    </div>
  );
};

export default QRModal;
