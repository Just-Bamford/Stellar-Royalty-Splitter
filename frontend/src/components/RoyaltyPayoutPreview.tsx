import { useState } from "react";
import "./RoyaltyPayoutPreview.css";

export const STROOPS_PER_XLM = 10_000_000;

export interface PreviewCollaborator {
  address: string;
  basisPoints: string; // percentage 0-100, same shape InitializeForm uses
}

export interface PayoutPreviewRow {
  address: string;
  basisPoints: number;
  payoutStroops: string;
  payoutXlm: number;
}

/**
 * Mirrors the contract's `checked_bps_amount`: floor(amount * bps / 10_000)
 * per collaborator, computed independently (no remainder redistribution).
 * Uses BigInt so large sample amounts don't lose precision the way the
 * on-chain integer math never would. This is informational only — the
 * contract's own calculation at distribution time is authoritative.
 */
export function calculatePayoutPreview(
  collaborators: PreviewCollaborator[],
  saleAmountXlm: string,
): PayoutPreviewRow[] {
  const amountXlm = parseFloat(saleAmountXlm);
  if (!saleAmountXlm || Number.isNaN(amountXlm) || amountXlm < 0) return [];

  const amountStroops = BigInt(Math.round(amountXlm * STROOPS_PER_XLM));

  return collaborators.map((c) => {
    const pct = parseFloat(c.basisPoints);
    const basisPoints = Number.isNaN(pct) ? 0 : Math.round(pct * 100);
    const payoutStroops = (amountStroops * BigInt(basisPoints)) / 10_000n;

    return {
      address: c.address,
      basisPoints,
      payoutStroops: payoutStroops.toString(),
      payoutXlm: Number(payoutStroops) / STROOPS_PER_XLM,
    };
  });
}

function truncateAddress(address: string) {
  return address.length > 12 ? `${address.slice(0, 6)}...${address.slice(-4)}` : address;
}

interface RoyaltyPayoutPreviewProps {
  collaborators: PreviewCollaborator[];
  isValid: boolean;
  invalidReason?: string;
}

export function RoyaltyPayoutPreview({
  collaborators,
  isValid,
  invalidReason,
}: RoyaltyPayoutPreviewProps) {
  const [saleAmount, setSaleAmount] = useState("");

  const rows = calculatePayoutPreview(collaborators, saleAmount);
  const amountEntered = saleAmount.trim() !== "";

  return (
    <div className="payout-preview" data-testid="payout-preview">
      <h4>Payout preview</h4>
      <p className="payout-preview__hint">
        Informational only — the contract's on-chain calculation is authoritative.
      </p>

      <label className="payout-preview__amount-label">
        Sample sale amount (XLM)
        <input
          type="number"
          min={0}
          step="any"
          placeholder="e.g. 100"
          value={saleAmount}
          onChange={(e) => setSaleAmount(e.target.value)}
        />
      </label>

      {!isValid && (
        <div className="status error" role="alert">
          {invalidReason ?? "Fix the collaborator allocations to see an accurate preview."}
        </div>
      )}

      {amountEntered && rows.length > 0 && (
        <table className="payout-preview__table">
          <thead>
            <tr>
              <th>Collaborator</th>
              <th>Share</th>
              <th>Estimated payout</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i}>
                <td title={row.address}>{row.address ? truncateAddress(row.address) : "—"}</td>
                <td>{(row.basisPoints / 100).toFixed(2)}%</td>
                <td>{row.payoutXlm.toFixed(7).replace(/\.?0+$/, "")} XLM</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {!amountEntered && (
        <div className="empty-state">Enter a sample sale amount to preview payouts.</div>
      )}
    </div>
  );
}
