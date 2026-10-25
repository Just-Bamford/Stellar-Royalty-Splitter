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
 * Mirrors the contract's `checked_bps_amount` and last-recipient dust assignment:
 * floor(amount * bps / 10_000) for the first N-1 collaborators, with the remainder
 * assigned to the last collaborator (amount - sum_of_first_n_minus_1_payouts).
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
  if (collaborators.length === 0) return [];

  const amountStroops = BigInt(Math.round(amountXlm * STROOPS_PER_XLM));

  const parsed = collaborators.map((c) => {
    const pct = parseFloat(c.basisPoints);
    const basisPoints = Number.isNaN(pct) ? 0 : Math.round(pct * 100);
    return { c, basisPoints };
  });

  const totalBasisPoints = parsed.reduce((sum, item) => sum + item.basisPoints, 0);

  let totalCalculated = 0n;
  const lastIndex = parsed.length - 1;

  return parsed.map((item, index) => {
    let payoutStroops: bigint;
    if (totalBasisPoints === 10_000 && index === lastIndex) {
      payoutStroops = amountStroops - totalCalculated;
    } else {
      payoutStroops = (amountStroops * BigInt(item.basisPoints)) / 10_000n;
      totalCalculated += payoutStroops;
    }

    return {
      address: item.c.address,
      basisPoints: item.basisPoints,
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
