import { useState, useEffect } from "react";
import { api, RoyaltyStats } from "../api";
import { signAndSubmitTransaction } from "../stellar";
import { useNetwork } from "../context/NetworkContext";
import { Skeleton } from "./Skeleton";


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
  const { network, networkMismatch } = useNetwork();
  const [tokenId, setTokenId] = useState<string>("");
  const [status, setStatus] = useState<{
    type: "ok" | "error" | "info";
    msg: string;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingData, setLoadingData] = useState(true);
  const [stats, setStats] = useState<RoyaltyStats | null>(null);
  const [poolBalance, setPoolBalance] = useState<string>("");

  // Load royalty stats and pool balance on mount/contract change
  useEffect(() => {
    if (!contractId) {
      setLoadingData(false);
      return;
    }

    setLoadingData(true);
    Promise.all([
      api.getRoyaltyStats(contractId).catch(() => null),
      api.getSecondaryRoyaltyPool(contractId).catch(() => ({ poolBalance: "0" })),
    ]).then(([s, p]) => {
      setStats(s);
      setPoolBalance(p?.poolBalance ?? "0");
      setLoadingData(false);
    });
  }, [contractId]);

  async function submit() {
    if (networkMismatch) {
      return setStatus({
        type: "error",
        msg: "Your wallet is on the wrong network. Switch it before submitting.",
      });
    }
    if (!contractId || !tokenId) {
      return setStatus({ type: "error", msg: "Please fill in all fields." });
    }

    if (poolBalance === "0") {
      return setStatus({ type: "error", msg: "No royalties available to distribute." });
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

      const result = await signAndSubmitTransaction(xdr, network);

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

  if (loadingData) {
    return (
      <div className="card" data-testid="distribute-royalties-loading">
        <h3>Distribute Secondary Royalties</h3>
        <p className="description">
          Distribute accumulated royalties from resales to collaborators.
        </p>
        <div className="stats-summary" style={{ padding: "0.5rem 0" }}>
          <Skeleton width="60%" height="1.25rem" className="mb-2" />
          <Skeleton width="80%" height="1.25rem" className="mb-2" />
          <Skeleton width="50%" height="1.25rem" className="mb-4" />
        </div>
        <Skeleton width="100%" height="2.5rem" className="mb-4" />
        <Skeleton width="160px" height="2.5rem" />
      </div>
    );
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
                {new Date(stats.lastDistribution.timestamp).toLocaleDateString()}
              </span>
            </div>
          )}
        </div>
      )}

      <div className="stat-item">
        <span className="stat-label">Current Pool Balance:</span>
        <span className="stat-value">{poolBalance}</span>
      </div>

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

      {networkMismatch && (
        <div className="message error">
          Your wallet is on the wrong network. Switch it to {network === "mainnet" ? "Mainnet" : "Testnet"} to distribute secondary royalties.
        </div>
      )}
      {status && <div className={`message ${status.type}`}>{status.msg}</div>}

      <button
        onClick={submit}
        disabled={loading || poolBalance === "0" || networkMismatch}
        className="btn-primary"
      >
        {loading ? "Processing..." : "Distribute Royalties"}
      </button>
    </div>
  );
}

