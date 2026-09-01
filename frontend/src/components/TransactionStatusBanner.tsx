/**
 * #653 — Inline transaction status banner
 *
 * Renders stage-specific feedback during wallet-based contract interactions:
 * - awaiting_wallet: prompts user to approve in Freighter
 * - submitting / confirming: animated progress indicator
 * - confirmed: success with optional tx link
 * - failed: error message + retry button
 */

import type { TxStage } from "../hooks/useTransactionLifecycle";
import { getStellarExpertTxUrl } from "../lib/explorer";
import type { Network } from "../context/NetworkContext";

interface TransactionStatusBannerProps {
  stage: TxStage;
  errorMessage?: string | null;
  txHash?: string | null;
  network?: Network;
  onRetry?: () => void;
  onDismiss?: () => void;
}

const STAGE_LABELS: Record<TxStage, string> = {
  idle: "",
  awaiting_wallet: "Waiting for wallet approval — check Freighter…",
  submitting: "Submitting transaction to the network…",
  confirming: "Waiting for confirmation…",
  confirmed: "Transaction confirmed.",
  failed: "",
};

const SPINNER_STAGES: TxStage[] = ["awaiting_wallet", "submitting", "confirming"];

export function TransactionStatusBanner({
  stage,
  errorMessage,
  txHash,
  network,
  onRetry,
  onDismiss,
}: TransactionStatusBannerProps) {
  if (stage === "idle") return null;

  const isSpinning = SPINNER_STAGES.includes(stage);
  const isFailed = stage === "failed";
  const isConfirmed = stage === "confirmed";

  const bannerClass = isFailed
    ? "tx-status-banner tx-status-banner--error"
    : isConfirmed
    ? "tx-status-banner tx-status-banner--success"
    : "tx-status-banner tx-status-banner--info";

  return (
    <div className={bannerClass} role="status" aria-live="polite">
      <div className="tx-status-banner__body">
        {isSpinning && (
          <span className="tx-status-banner__spinner" aria-hidden="true" />
        )}
        {isConfirmed && (
          <span className="tx-status-banner__icon" aria-hidden="true">✅</span>
        )}
        {isFailed && (
          <span className="tx-status-banner__icon" aria-hidden="true">❌</span>
        )}

        <span className="tx-status-banner__message">
          {isFailed
            ? errorMessage ?? "Transaction failed. Please try again."
            : STAGE_LABELS[stage]}
        </span>

        {isConfirmed && txHash && network && (
          <a
            className="tx-status-banner__link"
            href={getStellarExpertTxUrl(network, txHash)}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="View transaction on Stellar Expert"
          >
            View on Explorer ↗
          </a>
        )}
      </div>

      <div className="tx-status-banner__actions">
        {isFailed && onRetry && (
          <button
            type="button"
            className="tx-status-banner__btn tx-status-banner__btn--retry"
            onClick={onRetry}
          >
            Retry
          </button>
        )}
        {(isFailed || isConfirmed) && onDismiss && (
          <button
            type="button"
            className="tx-status-banner__btn tx-status-banner__btn--dismiss"
            onClick={onDismiss}
            aria-label="Dismiss notification"
          >
            ✕
          </button>
        )}
      </div>
    </div>
  );
}
