/**
 * AddressCopy  (#479)
 *
 * All-in-one address display widget with:
 *   • Copy button — clipboard API with fallback, toast confirmation
 *   • Verification UI — hover/focus reveals first-4 / last-4 chars
 *   • QR code modal — scannable code for mobile wallets
 *   • Paste validation — validates Stellar address format on paste
 */
import { useState, useCallback, useRef, useEffect } from "react";
import { QRCodeSVG } from "qrcode.react";
import {
  isValidStellarAddress,
  truncateStellarAddress,
  INVALID_STELLAR_ADDRESS_MESSAGE,
} from "../lib/stellar-address";
import { useNotification } from "../context/NotificationContext";
import "./AddressCopy.css";

// ── Types ──────────────────────────────────────────────────────────────────

export interface AddressCopyProps {
  /** The full Stellar address (C... or G...) */
  address: string;
  /** Optional human-readable label shown next to the address */
  label?: string;
  /** Number of chars shown at each end in truncated view (default: 4) */
  truncateChars?: number;
  /** Show the QR code button (default: true) */
  showQr?: boolean;
  /** Show the paste-validation input (default: false — opt-in) */
  showPasteValidation?: boolean;
  /** Additional CSS class on the root element */
  className?: string;
}

// ── QR Modal ───────────────────────────────────────────────────────────────

function QRModal({
  address,
  label,
  onClose,
}: {
  address: string;
  label?: string;
  onClose: () => void;
}) {
  // Close on Escape
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="ac-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="qr-modal-title"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="ac-modal">
        <div className="ac-modal-header">
          <h3 id="qr-modal-title" className="ac-modal-title">
            {label ? `QR — ${label}` : "Address QR Code"}
          </h3>
          <button
            type="button"
            className="ac-modal-close"
            aria-label="Close QR modal"
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        <div className="ac-qr-wrapper">
          <QRCodeSVG
            value={address}
            size={200}
            bgColor="var(--qr-bg, #ffffff)"
            fgColor="var(--qr-fg, #000000)"
            level="M"
            aria-label={`QR code for ${address}`}
          />
        </div>

        <p className="ac-modal-address" title={address}>
          {address}
        </p>

        <button
          type="button"
          className="ac-modal-copy-btn"
          onClick={() => navigator.clipboard.writeText(address)}
          aria-label="Copy address from QR modal"
        >
          📋 Copy address
        </button>
      </div>
    </div>
  );
}

// ── Paste Validation Input ─────────────────────────────────────────────────

function PasteValidator({ expected }: { expected: string }) {
  const [pasted, setPasted] = useState("");
  const [state, setState] = useState<"idle" | "valid" | "invalid" | "mismatch">("idle");

  function handlePaste(e: React.ClipboardEvent<HTMLInputElement>) {
    const value = e.clipboardData.getData("text").trim();
    setPasted(value);

    if (!isValidStellarAddress(value)) {
      setState("invalid");
      return;
    }
    setState(value === expected ? "valid" : "mismatch");
  }

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const value = e.target.value;
    setPasted(value);
    if (!value) { setState("idle"); return; }
    if (!isValidStellarAddress(value)) { setState("invalid"); return; }
    setState(value === expected ? "valid" : "mismatch");
  }

  const feedback: Record<typeof state, { msg: string; cls: string } | null> = {
    idle: null,
    valid: { msg: "✓ Address matches", cls: "ac-paste-ok" },
    invalid: { msg: `✕ ${INVALID_STELLAR_ADDRESS_MESSAGE}`, cls: "ac-paste-error" },
    mismatch: {
      msg: `⚠ Address does not match — expected ${truncateStellarAddress(expected)}`,
      cls: "ac-paste-warn",
    },
  };

  return (
    <div className="ac-paste-validator">
      <label htmlFor="ac-paste-input" className="ac-paste-label">
        Paste &amp; verify address
      </label>
      <input
        id="ac-paste-input"
        type="text"
        className={`ac-paste-input${state !== "idle" ? ` ac-paste-input--${state}` : ""}`}
        placeholder="Paste address to verify…"
        value={pasted}
        onPaste={handlePaste}
        onChange={handleChange}
        aria-describedby="ac-paste-feedback"
        autoComplete="off"
        spellCheck={false}
      />
      {feedback[state] && (
        <p
          id="ac-paste-feedback"
          className={`ac-paste-feedback ${feedback[state]!.cls}`}
          role="status"
          aria-live="polite"
        >
          {feedback[state]!.msg}
        </p>
      )}
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────

export function AddressCopy({
  address,
  label,
  truncateChars = 4,
  showQr = true,
  showPasteValidation = false,
  className = "",
}: AddressCopyProps) {
  const { success, error: notifyError } = useNotification();
  const [copied, setCopied] = useState(false);
  const [showFull, setShowFull] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);

  const truncated = truncateStellarAddress(address, truncateChars);
  const isValid = isValidStellarAddress(address);

  const handleCopy = useCallback(async () => {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      success("Address copied to clipboard", {
        title: label ? `${label} copied` : "Copied",
        duration: 3000,
      });
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback for browsers that deny clipboard without user gesture
      try {
        const el = document.createElement("textarea");
        el.value = address;
        el.style.position = "fixed";
        el.style.opacity = "0";
        document.body.appendChild(el);
        el.focus();
        el.select();
        document.execCommand("copy");
        document.body.removeChild(el);
        setCopied(true);
        success("Address copied to clipboard");
        setTimeout(() => setCopied(false), 2000);
      } catch {
        notifyError("Could not copy — please copy manually", {
          copyText: address,
        });
      }
    }
  }, [address, label, success, notifyError]);

  if (!address) return null;

  return (
    <div className={`ac-root${className ? ` ${className}` : ""}`}>
      <div className="ac-row">
        {/* Address display — hover/focus reveals full address */}
        <span
          className="ac-address"
          title={address}
          onMouseEnter={() => setShowFull(true)}
          onMouseLeave={() => setShowFull(false)}
          onFocus={() => setShowFull(true)}
          onBlur={() => setShowFull(false)}
          aria-label={`${label ?? "Address"}: ${address}`}
        >
          {showFull ? (
            <span className="ac-address-full">{address}</span>
          ) : (
            <span className="ac-address-truncated">
              <span className="ac-addr-start">{address.slice(0, truncateChars)}</span>
              <span className="ac-addr-dots">…</span>
              <span className="ac-addr-end">{address.slice(-truncateChars)}</span>
            </span>
          )}
          {!isValid && (
            <span className="ac-invalid-badge" title="Invalid Stellar address format">
              ⚠
            </span>
          )}
        </span>

        {/* Copy button */}
        <button
          ref={btnRef}
          type="button"
          className={`ac-copy-btn${copied ? " ac-copy-btn--copied" : ""}`}
          onClick={handleCopy}
          aria-label={copied ? "Copied to clipboard" : `Copy ${label ?? "address"}`}
          title={copied ? "Copied!" : "Copy address"}
        >
          {copied ? "✓" : "⧉"}
        </button>

        {/* QR button */}
        {showQr && isValid && (
          <button
            type="button"
            className="ac-qr-btn"
            onClick={() => setQrOpen(true)}
            aria-label={`Show QR code for ${label ?? "address"}`}
            title="Show QR code"
          >
            ▣
          </button>
        )}
      </div>

      {/* Paste validation (opt-in) */}
      {showPasteValidation && <PasteValidator expected={address} />}

      {/* QR modal */}
      {qrOpen && (
        <QRModal
          address={address}
          label={label}
          onClose={() => setQrOpen(false)}
        />
      )}
    </div>
  );
}

export default AddressCopy;
