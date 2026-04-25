import { useState } from "react";
import { api } from "../api";
import { signAndSubmitTransaction } from "../stellar";


interface Props {
  contractId: string;
  walletAddress: string;
  onSuccess: () => void;
}

export default function DistributeForm({
  contractId,
  walletAddress,
  onSuccess,
}: Props) {
  const [tokenId, setTokenId] = useState("");
  const [status, setStatus] = useState<{
    type: "ok" | "error" | "info";
    msg: string;
  } | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit() {
    if (!contractId)
      return setStatus({ type: "error", msg: "Enter a contract ID first." });
    if (!tokenId)
      return setStatus({ type: "error", msg: "Enter a token address." });

    setLoading(true);
    setStatus({ type: "info", msg: "Building transaction…" });

    try {
      const res = await api.distribute({ contractId, walletAddress, tokenId });

      setStatus({ type: "info", msg: "Signing transaction with Freighter..." });
      const hash = await signAndSubmitTransaction(res.xdr);

      setStatus({ type: "info", msg: "Waiting for confirmation..." });
      await api.confirmTransaction(hash, {
        status: "confirmed",
        blockTime: new Date().toISOString(),
      });

      setStatus({ type: "ok", msg: `Distributed. Tx: ${hash}` });
      onSuccess();
    } catch (e: unknown) {
      setStatus({ type: "error", msg: e instanceof Error ? e.message : "Unknown error" });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="card">
      <span className="badge">Distribute</span>
      <label>Token contract address</label>
      <input
        placeholder="C..."
        value={tokenId}
        onChange={(e) => setTokenId(e.target.value)}
      />
      <p className="description">Distributes the full contract balance to all collaborators.</p>
      <button className="btn-primary" onClick={submit} disabled={loading}>
        {loading ? "Submitting…" : "Distribute funds"}
      </button>
      {status && <div className={`status ${status.type}`}>{status.msg}</div>}
    </div>
  );
}
