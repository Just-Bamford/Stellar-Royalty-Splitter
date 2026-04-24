import { useState, useEffect } from "react";
import { api, RoyaltyStats } from "../api";
import { signAndSubmitTransaction } from "../stellar";


interface Props {
  contractId: string;
  walletAddress: string;
  onSuccess: () => void;
}

export default function DistributeSecondaryRoyalties({
  contractId,
  walletAddress,
  onSuccess,
}: Props) {
  const [tokenId, setTokenId] = useState<string>("");
  const [status, setStatus] = useState<{
    type: "ok" | "error" | "info";
    msg: string;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [stats, setStats] = useState<RoyaltyStats | null>(null);

  // Load royalty stats on component mount and contract change
  useEffect(() => {
    if (!contractId) return;

    api
      .getRoyaltyStats(contractId)
      .then(setStats)
      .catch(() => setStats(null));
  }, [contractId]);

  async function submit() {
    if (!contractId || !tokenId) {
      return setStatus({ type: "error", msg: "Please fill in all fields." });
    }

    setLoading(true);
    setStatus({ type: "info", msg: "Building distribution transaction..." });

    try {
      const { xdr, numberOfSales, totalRoyalties } =
        await api.distributeSecondaryRoyalties({
          contractId,
          walletAddress,
          tokenId,
        });

      if (numberOfSales === 0) {
        return setStatus({
          type: "error",
          msg: "No pending royalties to distribute.",
        });
      }

      setStatus({ type: "info", msg: "Please sign the transaction..." });

      // Sign and submit transaction
      const result = await signAndSubmitTransaction(xdr);

      setStatus({ type: "info", msg: "Waiting for confirmation..." });
      await api.confirmTransaction(result, {
        status: "confirmed",
        blockTime: new Date().toISOString(),
      });

      setStatus({
        type: "ok",
        msg: `Distributed ${totalRoyalties} tokens from ${numberOfSales} sales! TX: ${result}`,
      });


      setTokenId("");
      onSuccess();
    } catch (err) {
      setStatus({
        type: "error",
        msg: `Error: ${err instanceof Error ? err.message : "Unknown error"}`,
      });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="card">
      <h3>Distribute Secondary Royalties</h3>
      <p className="description">
        Distribute accumulated royalties from resales to collaborators.
      </p>

      {stats && (
        <div className="stats-summary">
          <div className="stat-item">
            <span className="stat-label">Total Secondary Sales:</span>
            <span className="stat-value">{stats.totalSecondarySales}</span>
          </div>
          <div className="stat-item">
            <span className="stat-label">Total Royalties Generated:</span>
            <span className="stat-value">{stats.totalRoyaltiesGenerated}</span>
          </div>
          {stats.lastDistribution && (
            <div className="stat-item">
              <span className="stat-label">Last Distribution:</span>
              <span className="stat-value">
                {new Date(
                  stats.lastDistribution.timestamp,
                ).toLocaleDateString()}
              </span>
            </div>
          )}
        </div>
      )}

      <div className="form-group">
        <label>Token Address</label>
        <input
          type="text"
          placeholder="C... (USDC or payment token)"
          value={tokenId}
          onChange={(e) => setTokenId(e.target.value)}
          disabled={loading}
        />
      </div>

      {status && <div className={`message ${status.type}`}>{status.msg}</div>}

      <button onClick={submit} disabled={loading} className="btn-primary">
        {loading ? "Processing..." : "Distribute Royalties"}
      </button>
    </div>
  );
}
