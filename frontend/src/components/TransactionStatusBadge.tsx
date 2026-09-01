/**
 * TransactionStatusBadge (#391)
 *
 * Shows the current transaction phase as a status badge with:
 * - Animated spinner while in-flight (building / signing / confirming)
 * - Estimated time remaining during confirmation
 * - Transaction hash link on confirmed
 * - Error message on failure / timeout
 */
import { useEffect, useState } from "react";
import type { TxPhase, TransactionEntry } from "../context/TransactionContext";
import { ESTIMATED_CONFIRMATION_SECS } from "../context/TransactionContext";
import type { Network } from "../context/NetworkContext";
import { getStellarExpertTxUrl, formatTxHash } from "../lib/explorer";
import "./TransactionStatusBadge.css";

interface Props {
  entry: TransactionEntry;
  network: Network;
  onDismiss?: () => void;
}

const PHASE_ICON: Record<TxPhase, string> = {
  idle: "",
  building: "⏳",
  signing: "✍️",
  confirming: "🔄",
  confirmed: "✅",
  failed: "❌",
  timeout: "⏱️",
};

function useCountdown(startMs: number | null): number | null {
  const [remaining, setRemaining] = useState<number | null>(null);

  useEffect(() => {
    if (startMs === null) {
      setRemaining(null);
      return;
    }
    function tick() {
      const elapsed = (Date.now() - startMs!) / 1000;
      const left = Math.max(0, ESTIMATED_CONFIRMATION_SECS - elapsed);
      setRemaining(Math.ceil(left));
    }
    tick();
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, [startMs]);

  return remaining;
}

export default function TransactionStatusBadge({ entry, network, onDismiss }: Props) {
  const { phase, label, txHash, errorMessage, confirmingStartedAt, transactionId } = entry;
  const remaining = useCountdown(
    phase === "confirming" ? confirmingStartedAt : null,
  );

  const isTerminal = phase === "confirmed" || phase === "failed" || phase === "timeout";
  const isInFlight = phase === "building" || phase === "signing" || phase === "confirming";

  return (
    <div
      className={`tx-status-badge tx-status-badge--${phase}`}
      role="status"
      aria-live="polite"
      aria-atomic="true"
      data-testid="tx-status-badge"
      data-phase={phase}
    >
      <div className="tx-status-badge__row">
        {isInFlight && (
          <span
            className="tx-status-badge__spinner"
            aria-hidden="true"
          />
        )}
        <span className="tx-status-badge__icon" aria-hidden="true">
          {PHASE_ICON[phase]}
        </span>
        <span className="tx-status-badge__label">{label}</span>

        {phase === "confirming" && remaining !== null && remaining > 0 && (
          <span
            className="tx-status-badge__eta"
            aria-label={`Estimated ${remaining} seconds remaining`}
          >
            ~{remaining}s
          </span>
        )}

        {isTerminal && onDismiss && (
          <button
            type="button"
            className="tx-status-badge__dismiss"
            onClick={onDismiss}
            aria-label="Dismiss transaction status"
          >
            ×
          </button>
        )}
      </div>

      {transactionId !== null && (
        <div className="tx-status-badge__id">
          Transaction ID:{" "}
          <code data-testid="tx-transaction-id">{transactionId}</code>
        </div>
      )}

      {phase === "confirmed" && txHash && (
        <div className="tx-status-badge__hash">
          <a
            href={getStellarExpertTxUrl(network, txHash)}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`View transaction ${txHash} on Stellar Expert`}
            data-testid="tx-hash-link"
          >
            {formatTxHash(txHash)}
            <span aria-hidden="true"> ↗</span>
          </a>
        </div>
      )}

      {(phase === "failed" || phase === "timeout") && errorMessage && (
        <div className="tx-status-badge__error" data-testid="tx-error-message">
          {errorMessage}
        </div>
      )}
    </div>
  );
}
