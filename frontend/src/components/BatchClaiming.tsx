import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { signAndSubmitTransaction } from "../stellar";
import { useNetwork } from "../context/NetworkContext";

export interface PendingClaim {
  /** Token contract address. It is the identifier validated by the contract. */
  tokenId: string;
  /** Display-only amount from an authoritative pending-distribution query. */
  amount: string;
  label?: string;
}

interface Props {
  contractId: string;
  walletAddress: string;
  pendingClaims?: PendingClaim[];
  onSuccess?: (transactionHash: string, claimedTokens: string[]) => void;
}

type Estimate = Awaited<ReturnType<typeof api.estimateBatchDistribution>>;

const stroops = (value: string) => {
  try { return BigInt(value); } catch { return 0n; }
};

/**
 * Selection and review UI for the contract's atomic `batch_distribute` call.
 * The component never accepts an amount for submission: balances and payouts
 * are revalidated by the contract, protecting stale display data.
 */
export default function BatchClaiming({ contractId, walletAddress, pendingClaims: providedClaims, onSuccess }: Props) {
  const { network, networkMismatch } = useNetwork();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loadedClaims, setLoadedClaims] = useState<PendingClaim[] | null>(null);
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<{ type: "error" | "success" | "info"; text: string } | null>(null);

  useEffect(() => {
    if (providedClaims) {
      setLoadedClaims(providedClaims);
      return;
    }
    let cancelled = false;
    api.getPendingDistributions(contractId)
      .then(({ distributions }) => { if (!cancelled) setLoadedClaims(distributions); })
      .catch(() => { if (!cancelled) setLoadedClaims([]); });
    return () => { cancelled = true; };
  }, [contractId, providedClaims]);

  const pendingClaims = loadedClaims ?? [];
  const uniqueClaims = useMemo(() => {
    const seen = new Set<string>();
    return pendingClaims.filter((claim) => claim.tokenId && !seen.has(claim.tokenId) && (seen.add(claim.tokenId), true));
  }, [pendingClaims]);
  const invalidCount = pendingClaims.length - uniqueClaims.length;
  const selectedClaims = uniqueClaims.filter((claim) => selected.has(claim.tokenId));
  const totalAmount = selectedClaims.reduce((total, claim) => total + stroops(claim.amount), 0n);

  useEffect(() => {
    setSelected((current) => new Set([...current].filter((token) => uniqueClaims.some((claim) => claim.tokenId === token))));
  }, [uniqueClaims]);

  useEffect(() => {
    let cancelled = false;
    if (selectedClaims.length === 0) {
      setEstimate(null);
      return;
    }
    api.estimateBatchDistribution(selectedClaims.length)
      .then((result) => { if (!cancelled) setEstimate(result); })
      .catch(() => { if (!cancelled) setEstimate(null); });
    return () => { cancelled = true; };
  }, [selectedClaims.length]);

  const toggle = (tokenId: string) => setSelected((current) => {
    const next = new Set(current);
    next.has(tokenId) ? next.delete(tokenId) : next.add(tokenId);
    return next;
  });
  const selectAll = () => setSelected(new Set(uniqueClaims.map((claim) => claim.tokenId)));
  const selectNone = () => { setSelected(new Set()); setReviewing(false); };

  async function execute() {
    if (submitting || selectedClaims.length === 0 || networkMismatch) return;
    setSubmitting(true);
    setMessage({ type: "info", text: "Building one atomic batch transaction…" });
    try {
      const tokens = selectedClaims.map((claim) => claim.tokenId);
      const result = await api.buildBatchDistribution({
        contractId,
        walletAddress,
        tokens,
        idempotencyKey: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${tokens.join("-")}`,
      });
      setMessage({ type: "info", text: "Please sign the batch transaction." });
      const transactionHash = await signAndSubmitTransaction(result.xdr, network);
      setSelected(new Set());
      setReviewing(false);
      setMessage({ type: "success", text: `Batch distribution confirmed: ${transactionHash}` });
      onSuccess?.(transactionHash, tokens);
    } catch (error) {
      setMessage({ type: "error", text: error instanceof Error ? error.message : "Batch distribution failed; no selected claim was marked complete." });
    } finally {
      setSubmitting(false);
    }
  }

  return <section className="card" aria-labelledby="batch-claim-title">
    <h3 id="batch-claim-title">Batch pending distributions</h3>
    <p className="description">Selected tokens are submitted in one atomic transaction. Estimates are not guaranteed network fees.</p>
    {invalidCount > 0 && <p className="message error" role="alert">{invalidCount} duplicate or invalid selection{invalidCount === 1 ? " was" : "s were"} excluded.</p>}
    {loadedClaims === null ? <p className="description" role="status">Loading pending distributions…</p> : uniqueClaims.length === 0 ? <p className="description" role="status">No pending distributions are available.</p> : <>
      <div className="form-actions">
        <button type="button" className="btn-secondary" onClick={selectAll} disabled={submitting}>Select all</button>
        <button type="button" className="btn-secondary" onClick={selectNone} disabled={submitting}>Select none</button>
      </div>
      <div role="group" aria-label="Pending distributions">
        {uniqueClaims.map((claim) => <label key={claim.tokenId} className="stat-item">
          <input type="checkbox" checked={selected.has(claim.tokenId)} onChange={() => toggle(claim.tokenId)} disabled={submitting} />
          <span>{claim.label ?? claim.tokenId}</span><strong>{claim.amount}</strong>
        </label>)}
      </div>
      <p aria-live="polite">Selected: {selectedClaims.length}. Total amount: {totalAmount.toString()}.</p>
      {estimate && <div className="stats-summary" aria-label="Estimated transaction costs">
        <div className="stat-item"><span>Individual estimate</span><strong>{estimate.individualCost} stroops</strong></div>
        <div className="stat-item"><span>Batch estimate</span><strong>{estimate.batchCost} stroops</strong></div>
        <div className="stat-item"><span>Estimated savings</span><strong>{estimate.savings} stroops ({estimate.savingsPercent}%)</strong></div>
      </div>}
      {reviewing && <div className="message info" role="status">Review: all {selectedClaims.length} selected distributions will succeed or fail together.</div>}
      {networkMismatch && <p className="message error" role="alert">Switch to the selected network before submitting.</p>}
      {message && <p className={`message ${message.type}`} role={message.type === "error" ? "alert" : "status"}>{message.text}</p>}
      {!reviewing ? <button type="button" className="btn-primary" onClick={() => setReviewing(true)} disabled={selectedClaims.length === 0 || submitting || networkMismatch}>Review batch</button> : <button type="button" className="btn-primary" onClick={execute} disabled={selectedClaims.length === 0 || submitting || networkMismatch} aria-busy={submitting}>{submitting ? "Submitting…" : "Execute batch distribution"}</button>}
    </>}
  </section>;
}
