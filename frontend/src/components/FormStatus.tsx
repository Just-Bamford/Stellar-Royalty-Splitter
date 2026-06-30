import type { Network } from "../context/NetworkContext";
import { getStellarExpertTxUrl, formatTxHash } from "../lib/explorer";
import { sanitizeErrorMessage } from "../lib/sanitize";

export type FormStatusType = "ok" | "error" | "info";

interface FormStatusProps {
  type: FormStatusType;
  message: string;
  txHash?: string;
  network?: Network;
  distributionData?: {
    totalDistributed?: number;
    recipientCount?: number;
  };
}

export default function FormStatus({
  type,
  message,
  txHash,
  network,
  distributionData,
}: FormStatusProps) {
  const showTxLink = type === "ok" && txHash && network;

  async function handleShare() {
    if (!txHash || !network) return;

    const txUrl = getStellarExpertTxUrl(network, txHash);
    const summary = `Distribution completed!
Transaction: ${txUrl}
${distributionData?.totalDistributed ? `Total distributed: ${distributionData.totalDistributed} XLM` : ""}
${distributionData?.recipientCount ? `Recipients: ${distributionData.recipientCount}` : ""}`;

    try {
      if (navigator.share) {
        await navigator.share({
          title: "Stellar Royalty Distribution",
          text: summary,
          url: window.location.href,
        });
      } else {
        await navigator.clipboard.writeText(summary);
        alert("Summary copied to clipboard!");
      }
    } catch (error) {
      if (error instanceof Error && error.name !== "AbortError") {
        console.error("Failed to share:", error);
      }
    }
  }

  return (
    <div className={`form-status form-status--${type}`}>
      {/* #499: backend/contract error text is sanitised to inert plain text. */}
      <span>{sanitizeErrorMessage(message)}</span>
      {showTxLink && (
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          <a
            className="form-status__tx-link"
            href={getStellarExpertTxUrl(network, txHash)}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`View transaction ${txHash} on Stellar Expert`}
          >
            <span className="form-status__tx-icon" aria-hidden="true">
              ↗
            </span>
            {formatTxHash(txHash)}
          </a>
          <button
            type="button"
            onClick={handleShare}
            style={{
              background: "transparent",
              border: "1px solid currentColor",
              color: "inherit",
              padding: "0.25rem 0.75rem",
              fontSize: "0.875rem",
              borderRadius: "4px",
              cursor: "pointer",
            }}
            aria-label="Share distribution summary"
          >
            Share
          </button>
        </div>
      )}
    </div>
  );
}
