import { useState, useEffect } from "react";
import { api, RoyaltyStats } from "../api";
import { signAndSubmitTransaction } from "../stellar";
import { useNetwork } from "../context/NetworkContext";
import { ListSkeleton } from "./Skeleton";

const C_ADDR = /^C[A-Z2-7]{55}$/;
const TOKEN_ID_ERROR = "Please enter a valid token contract address (C..., 56 chars).";

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
  const [tokenIdError, setTokenIdError] = useState("");
  const [status, setStatus] = useState<{
    type: "ok" | "error" | "info";
    msg: string;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [stats, setStats] = useState<RoyaltyStats | null>(null);
  const [poolBalance, setPoolBalance] = useState<string>("");
  const [loadingData, setLoadingData] = useState(true);

  // Load royalty stats and pool balance together on mount/contract change, so
  // they appear at the same time instead of popping in one by one.
  useEffect(() => {
    if (!contractId) {
      setLoadingData(false);
      return;
    }

    let cancelled = false;
    setLoadingData(true);
    Promise.all([
      api.getRoyaltyStats(contractId).catch(() => null),
      api.getSecondaryRoyaltyPool(contractId).catch(() => ({ poolBalance: "0" })),
    ]).then(([nextStats, pool]) => {
      if (cancelled) return;
      setStats(nextStats);
      setPoolBalance(pool?.poolBalance ?? "0");
      setLoadingData(false);
    });

    return () => {
      cancelled = true;
    };
  }, [contractId]);

  function validateTokenId(value: string) {
    setTokenIdError(value !== "" && !C_ADDR.test(value) ? TOKEN_ID_ERROR : "");
  }

  function updateTokenId(value: string) {
    setTokenId(value);
    if (tokenIdError) setTokenIdError("");
  }

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

    if (!C_ADDR.test(tokenId)) {
      setTokenIdError(TOKEN_ID_ERROR);
      return setStatus({ type: "error", msg: TOKEN_ID_ERROR });
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
      setTokenIdError("");
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
      <div className="card">
        <h3>Distribute Secondary Royalties</h3>
        <ListSkeleton items={3} label="Loading royalty data…" />
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
          onChange={(e) => updateTokenId(e.target.value)}
          onBlur={(e) => validateTokenId(e.target.value)}
          disabled={loading}
          className={tokenIdError ? "input-error" : ""}
        />
        {tokenIdError && <span className="field-error">{tokenIdError}</span>}
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

