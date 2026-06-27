/**
 * ContractAddress (#418)
 *
 * Displays a Stellar contract address in a copy/verify-friendly way:
 * - monospace, middle-truncated so it stays readable on mobile
 * - full address in a hover tooltip (and aria-label) for verification
 * - validity badge computed on mount (Stellar C-address format)
 * - copy-to-clipboard with a transient toast confirmation
 * - a QR-code modal for easy sharing
 */
import { useEffect, useMemo, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { isValidContractAddress } from "../lib/stellar-address";
import { CopyButton } from "./CopyButton";
import "./ContractAddress.css";

interface ContractAddressProps {
  address: string;
  label?: string;
}

/** Middle-truncates a long address (keeps it verifiable but compact). */
export function truncateMiddle(value: string, lead = 8, tail = 6): string {
  if (value.length <= lead + tail + 1) return value;
  return `${value.slice(0, lead)}…${value.slice(-tail)}`;
}

export function ContractAddress({ address, label = "contract address" }: ContractAddressProps) {
  // Validated on mount (and whenever the address changes).
  const isValid = useMemo(() => isValidContractAddress(address), [address]);
  const [showQr, setShowQr] = useState(false);
  const [showToast, setShowToast] = useState(false);

  // Allow closing the QR modal with Escape.
  useEffect(() => {
    if (!showQr) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShowQr(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showQr]);

  function handleCopied() {
    setShowToast(true);
    setTimeout(() => setShowToast(false), 2000);
  }

  return (
    <div className="contract-address" data-testid="contract-address">
      <div className="contract-address__row">
        <code
          className="contract-address__value"
          title={address}
          aria-label={`${label}: ${address}`}
        >
          {truncateMiddle(address)}
        </code>
        <span
          className={`contract-address__badge ${isValid ? "is-valid" : "is-invalid"}`}
          role="status"
          title={
            isValid
              ? "Valid Stellar contract address"
              : "Invalid contract address format"
          }
        >
          {isValid ? "✓ Valid" : "⚠ Invalid"}
        </span>
      </div>

      <div className="contract-address__actions">
        <CopyButton value={address} label={label} size="sm" onCopied={handleCopied} />
        <button
          type="button"
          className="copy-btn-sm"
          onClick={() => setShowQr(true)}
          aria-haspopup="dialog"
          aria-label="Show QR code"
        >
          🔳 QR
        </button>
      </div>

      {showToast && (
        <div className="contract-address__toast" role="status" aria-live="polite">
          Address copied to clipboard
        </div>
      )}

      {showQr && (
        <div
          className="contract-address__modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Contract address QR code"
          onClick={() => setShowQr(false)}
        >
          <div
            className="contract-address__modal"
            onClick={(e) => e.stopPropagation()}
          >
            <h4>Contract address</h4>
            <QRCodeSVG value={address} size={200} data-testid="contract-qr" />
            <code className="contract-address__modal-value">{address}</code>
            <div className="contract-address__actions">
              <CopyButton value={address} label={label} size="sm" onCopied={handleCopied} />
              <button
                type="button"
                className="copy-btn-sm"
                onClick={() => setShowQr(false)}
                aria-label="Close QR code"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
