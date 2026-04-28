import React, { useState, useEffect } from "react";
import { api } from "../api";
import { signAndSubmitTransaction } from "../stellar";
import FormStatus from "./FormStatus";
import { useFormStatus } from "../hooks/useFormStatus";

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
  const [amount, setAmount] = useState("");
  const [contractBalance, setContractBalance] = useState<string | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const { status, setStatus } = useFormStatus();
  const [loading, setLoading] = useState(false);

  // Fetch contract balance whenever tokenId changes (debounced)
  useEffect(() => {
    if (!contractId || !tokenId) {
      setContractBalance(null);
      return;
    }
    const timer = setTimeout(async () => {
      setBalanceLoading(true);
      try {
        const res = await api.getContractBalance(contractId, tokenId);
        setContractBalance(res.balance);
      } catch {
        setContractBalance(null);
      } finally {
        setBalanceLoading(false);
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [contractId, tokenId]);

  const parsedAmount = parseFloat(amount);
  const parsedBalance = contractBalance !== null ? parseFloat(contractBalance) : null;
  const exceedsBalance =
    parsedBalance !== null && !isNaN(parsedAmount) && parsedAmount > parsedBalance;

  async function submit() {
    if (!contractId)
      return setStatus("error", "Enter a contract ID first.");
    if (!tokenId)
      return setStatus("error", "Enter a token address.");
    if (!amount || isNaN(parsedAmount) || parsedAmount <= 0)
      return setStatus("error", "Enter a valid amount.");
    if (exceedsBalance)
      return setStatus("error", "Amount exceeds contract balance.");

    setLoading(true);
    setStatus("info", "Building transaction…");

    try {
      const res = await api.distribute({ contractId, walletAddress, tokenId });

      setStatus("info", "Signing transaction with Freighter...");
      const hash = await signAndSubmitTransaction(res.xdr);

      setStatus("info", "Waiting for confirmation...");
      await api.confirmTransaction(hash, {
        status: "confirmed",
        blockTime: new Date().toISOString(),
      });

      setStatus("ok", `Distributed. Tx: ${hash}`);
      onSuccess();
    } catch (e: unknown) {
      setStatus("error", e instanceof Error ? e.message : "Unknown error");
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
        onChange={(e) => { setTokenId(e.target.value); setAmount(""); }}
      />
      {tokenId && (
        <p className="description">
          {balanceLoading
            ? "Fetching balance…"
            : contractBalance !== null
            ? `Available balance: ${contractBalance}`
            : "Could not fetch balance."}
        </p>
      )}
      <label>Amount</label>
      <input
        type="number"
        placeholder="0"
        min="0"
        max={contractBalance ?? undefined}
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        disabled={contractBalance === null}
      />
      {exceedsBalance && (
        <p className="description" style={{ color: "var(--error, red)" }}>
          Amount exceeds available balance of {contractBalance}.
        </p>
      )}
      <p className="description">Distributes the specified amount to all collaborators.</p>
      <button
        className="btn-primary"
        onClick={submit}
        disabled={loading || exceedsBalance || !amount}
      >
        {loading ? "Submitting…" : "Distribute funds"}
      </button>
      {status && <FormStatus type={status.type} message={status.message} />}
    </div>
  );
}
