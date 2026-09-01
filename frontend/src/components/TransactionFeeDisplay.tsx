/**
 * TransactionFeeDisplay — closes #606.
 *
 * Shows the Soroban resource fee deducted for a given transaction or
 * a paginated list of recent fees for a contract.
 */
import { useState, useEffect } from "react";
import { api } from "../api";

interface FeeRecord {
  transactionId: number;
  feeStroops: string;
  recordedAt: string;
}

interface Props {
  contractId: string;
}

/** Convert stroops (1e-7 XLM) to a human-readable XLM string. */
function stroopsToXlm(stroops: string): string {
  const n = Number(stroops);
  if (isNaN(n)) return stroops;
  return (n / 10_000_000).toFixed(7).replace(/\.?0+$/, "") + " XLM";
}

export function TransactionFeeDisplay({ contractId }: Props) {
  const [fees, setFees] = useState<FeeRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!contractId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);

    api
      .getContractFees(contractId)
      .then((res) => {
        if (!cancelled) setFees(res.data);
      })
      .catch((e: unknown) => {
        if (!cancelled)
          setError(e instanceof Error ? e.message : "Failed to load fee data");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [contractId]);

  if (loading) {
    return (
      <div className="fee-display" aria-live="polite" aria-busy="true">
        <p className="description">Loading fee records…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="fee-display fee-display--error" role="alert">
        <p className="field-error">{error}</p>
      </div>
    );
  }

  if (fees.length === 0) {
    return (
      <div className="fee-display">
        <p className="description">No fee records found for this contract.</p>
      </div>
    );
  }

  return (
    <section className="fee-display card" aria-label="Transaction fee breakdown">
      <span className="badge">Transaction Fees</span>
      <p className="description">
        Soroban resource fees deducted from each distribution transaction.
      </p>
      <table className="fee-table" role="table">
        <thead>
          <tr>
            <th scope="col">Transaction ID</th>
            <th scope="col">Fee</th>
            <th scope="col">Recorded</th>
          </tr>
        </thead>
        <tbody>
          {fees.map((f) => (
            <tr key={f.transactionId}>
              <td>#{f.transactionId}</td>
              <td>
                <span title={`${f.feeStroops} stroops`}>
                  {stroopsToXlm(f.feeStroops)}
                </span>
              </td>
              <td>{new Date(f.recordedAt).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
