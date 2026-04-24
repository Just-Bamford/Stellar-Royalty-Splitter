import { useState } from "react";
import { api } from "../api";
import { useSettings } from "../context/SettingsContext";
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
  const { settings } = useSettings();
  const [tokenId, setTokenId] = useState("");
  const [amount, setAmount] = useState("");
  const [status, setStatus] = useState<{
    type: "ok" | "error" | "info";
    msg: string;
  } | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit() {
    if (!contractId)
      return setStatus({ type: "error", msg: "Enter a contract ID first." });
    if (!tokenId || !amount)
      return setStatus({ type: "error", msg: "Fill in token and amount." });

    const numeric = parseFloat(amount);
    if (numeric < settings.minPayoutAmount) {
      return setStatus({ type: "error", msg: `Amount is below minimum payout (${settings.minPayoutAmount}).` });
    }

    setLoading(true);
    setStatus({ type: "info", msg: "Building transaction…" });

    try {
      const res = await api.distribute({
        contractId,
        walletAddress,
        tokenId,
        amount: parseInt(amount),
      });

      setStatus({ type: "info", msg: "Signing transaction with Freighter..." });
      const hash = await signAndSubmitTransaction(res.xdr);

      setStatus({ type: "info", msg: "Waiting for confirmation..." });
      await api.confirmTransaction(hash, {
        status: "confirmed",
        blockTime: new Date().toISOString(),
      });

      setStatus({ type: "ok", msg: `Distributed. Tx: ${hash}` });
      onSuccess();

    } catch (e: any) {
      setStatus({ type: "error", msg: e.message });
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
      <label>Amount (stroops)</label>
      <input
        placeholder="e.g. 10000000"
        type="number"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
      />
      <button className="btn-primary" onClick={submit} disabled={loading}>
        {loading ? "Submitting…" : "Distribute funds"}
      </button>
      {status && <div className={`status ${status.type}`}>{status.msg}</div>}
    </div>
  );
}
