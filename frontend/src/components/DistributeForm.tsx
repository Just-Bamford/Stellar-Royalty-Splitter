import { useState, useEffect, useMemo } from "react";
import { api } from "../api";
import { getContractAddressError, isValidContractAddress } from "../lib/stellar-address";
import { signAndSubmitTransaction } from "../stellar";
import { useNetwork } from "../context/NetworkContext";
import { useTransactionStore } from "../store/transactionsStore";
import FormStatus from "./FormStatus";
import TransactionStatusBadge from "./TransactionStatusBadge";
import { useFormStatus } from "../hooks/useFormStatus";
import { useTransactionLifecycle } from "../hooks/useTransactionLifecycle";
import { TransactionStatusBanner } from "./TransactionStatusBanner";
import {
  getContractAddressValidationError,
  getAmountValidationError,
  getFieldState,
  getFieldInputClass,
  getAriaInvalid,
  type FieldState,
} from "../lib/formValidation";
import "./TransactionStatusBanner.css";

interface Props {
  contractId: string;
  walletAddress: string;
  onSuccess: () => void;
}

interface CollaboratorShare {
  address: string;
  basisPoints: number;
}

interface DistributionDraft {
  tokenId: string;
  amount: string;
}

const DRAFT_KEY_PREFIX = "srs_distribute_draft";

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function formatXlmAmount(value: number): string {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 7,
  }).format(value);
}

function readDraft(key: string): DistributionDraft | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<DistributionDraft>;
    if (!parsed.tokenId && !parsed.amount) return null;
    return {
      tokenId: parsed.tokenId ?? "",
      amount: parsed.amount ?? "",
    };
  } catch {
    localStorage.removeItem(key);
    return null;
  }
}

export default function DistributeForm({
  contractId,
  walletAddress,
  onSuccess,
}: Props) {
  const { network, networkMismatch } = useNetwork();
  const { current: txEntry, beginTransaction, updatePhase, reset: resetTx } = useTransaction();
  const isInFlight = useIsTransactionInFlight();

  const [tokenId, setTokenId] = useState("");
  const [amount, setAmount] = useState("");
  const [contractBalance, setContractBalance] = useState<string | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [collaborators, setCollaborators] = useState<CollaboratorShare[]>([]);
  const [collaboratorsLoading, setCollaboratorsLoading] = useState(false);
  const [draftPrompt, setDraftPrompt] = useState<DistributionDraft | null>(null);
  const [draftDecisionMade, setDraftDecisionMade] = useState(false);
  const { status, setStatus, clearStatus } = useFormStatus();

  // Use TransactionContext's in-flight flag as the primary loading gate (#391)
  const [loading, setLoading] = useState(false);
  const [successTxHash, setSuccessTxHash] = useState<string | null>(null);
  const [touched, setTouched] = useState<{ tokenId?: boolean; amount?: boolean }>({});
  // #653 — full transaction lifecycle state for granular wallet feedback
  const txLifecycle = useTransactionLifecycle();
  const draftKey = useMemo(
    () => `${DRAFT_KEY_PREFIX}:${walletAddress}:${contractId || "no-contract"}`,
    [contractId, walletAddress],
  );

  useEffect(() => {
    const draft = readDraft(draftKey);
    setDraftPrompt(draft);
    setDraftDecisionMade(!draft);
  }, [draftKey]);

  useEffect(() => {
    if (!draftDecisionMade) return;

    if (tokenId || amount) {
      localStorage.setItem(draftKey, JSON.stringify({ tokenId, amount }));
    } else {
      localStorage.removeItem(draftKey);
    }
  }, [amount, draftDecisionMade, draftKey, tokenId]);

  useEffect(() => {
    if (!contractId) {
      setCollaborators([]);
      return;
    }

    let cancelled = false;
    setCollaboratorsLoading(true);

    api
      .getCollaborators(contractId)
      .then((items) => {
        if (!cancelled) setCollaborators(items);
      })
      .catch(() => {
        if (!cancelled) setCollaborators([]);
      })
      .finally(() => {
        if (!cancelled) setCollaboratorsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [contractId]);

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

  // Live token-address validation. The error is null for empty input so an
  // untouched field is not flagged as malformed (emptiness is reported as a
  // "required" error on submit instead, matching existing behaviour).
  const tokenIdError = getContractAddressError(tokenId);
  const tokenIdValid = isValidContractAddress(tokenId);
  const recipientBreakdown = useMemo(() => {
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0 || collaborators.length === 0) {
      return [];
    }

    let totalCalculated = 0;
    return collaborators.map((collaborator, index) => {
      const isLast = index === collaborators.length - 1;
      const payout = isLast
        ? Math.max(parsedAmount - totalCalculated, 0)
        : (parsedAmount * collaborator.basisPoints) / 10_000;

      totalCalculated += payout;

      return {
        ...collaborator,
        payout,
      };
    });
  }, [collaborators, parsedAmount]);

  const totalBasisPoints = collaborators.reduce(
    (total, collaborator) => total + collaborator.basisPoints,
    0,
  );

  // Progressive validation field states
  const tokenIdFieldState: FieldState = getFieldState(
    touched.tokenId ?? false,
    getContractAddressValidationError(tokenId),
  );
  const amountValue = amount.trim();
  const amountFieldState: FieldState = getFieldState(
    touched.amount ?? false,
    amountValue ? getAmountValidationError(amountValue) : null,
  );

  function handleTokenIdBlur() {
    setTouched((prev) => ({ ...prev, tokenId: true }));
  }

  function handleAmountBlur() {
    setTouched((prev) => ({ ...prev, amount: true }));
  }

  async function submit() {
    // #391: Don't resubmit if already in-flight
    if (isInFlight) return;

    if (networkMismatch)
      return setStatus("error", "Your wallet is on the wrong network. Switch it before submitting.");
    if (!contractId)
      return setStatus("error", "Enter a contract ID first.");
    if (!tokenId)
      return setStatus("error", "Enter a token address.");
    if (!tokenIdValid)
      return setStatus("error", "Enter a valid Stellar token address (C...).");
    if (!amount || isNaN(parsedAmount) || parsedAmount <= 0)
      return setStatus("error", "Enter a valid amount.");
    if (exceedsBalance)
      return setStatus("error", "Amount exceeds contract balance.");

    // #391: Begin optimistic transaction state
    beginTransaction();
    // #657 — prevent duplicate submissions: block if a tx is already in flight
    if (loading || txLifecycle.isActive) return;

    setLoading(true);
    txLifecycle.setStage("awaiting_wallet");

    // #657 — generate a per-submission idempotency key to guard against
    // network retries creating duplicate on-chain transactions
    const idempotencyKey = `dist-${walletAddress.slice(0, 8)}-${contractId.slice(0, 8)}-${Date.now()}`;

    try {
      const res = await api.distribute({
        contractId,
        walletAddress,
        tokenId,
        amount: parsedAmount,
        // @ts-ignore — idempotency key passed via headers in the api layer
        _idempotencyKey: idempotencyKey,
      });

      // #391: Phase 2 — signing
      updatePhase("signing", { transactionId: res.transactionId });
      txLifecycle.setStage("submitting");

      // Single stable "Retrying submission…" state in the UI while the
      // submission layer transparently retries transient RPC/network
      // failures (100ms / 500ms / 2s backoff, max 3 retries). Permanent
      // failures surface immediately as errors.
      const hash = await signAndSubmitTransaction(res.xdr, network, {
        onRetry: () => updatePhase("confirming", { label: "Retrying submission…" }),
      });

      // #391: Phase 3 — confirming, with countdown
      updatePhase("confirming", { txHash: hash });
      txLifecycle.setStage("confirming");

      await api.confirmTransaction(hash, {
        status: "confirmed",
        blockTime: new Date().toISOString(),
        transactionId: res.transactionId,
      });

      // #391: Phase 4 — confirmed
      updatePhase("confirmed");

      setSuccessTxHash(hash);
      txLifecycle.setConfirmed(hash);
      setStatus("ok", "Distributed successfully.");
      localStorage.removeItem(draftKey);
      setTokenId("");
      setAmount("");
      onSuccess();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      const isTimeout =
        msg.toLowerCase().includes("timeout") ||
        msg.toLowerCase().includes("timed out");

      // #391: Handle timeout scenario gracefully
      updatePhase(isTimeout ? "timeout" : "failed", { error: msg });
      setStatus("error", msg);
      txLifecycle.setFailed(msg);
      setStatus("error", msg);
    } finally {
      setLoading(false);
    }
  }

  function restoreDraft() {
    if (!draftPrompt) return;
    setTokenId(draftPrompt.tokenId);
    setAmount(draftPrompt.amount);
    setDraftPrompt(null);
    setDraftDecisionMade(true);
    setStatus("info", "Previous distribute draft restored.");
  }

  function discardDraft() {
    localStorage.removeItem(draftKey);
    setDraftPrompt(null);
    setDraftDecisionMade(true);
  }

  function handleShortcutSubmit(event: React.KeyboardEvent<HTMLFormElement>) {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      void submit();
    }
  }

  function clearForm() {
    setTokenId("");
    setAmount("");
    setContractBalance(null);
    setDraftPrompt(null);
    setDraftDecisionMade(true);
    localStorage.removeItem(draftKey);
    clearStatus();
    resetTx();
    txLifecycle.reset();
  }

  return (
    <form
      className="card"
      aria-describedby="distribute-shortcut-hint"
      onKeyDown={handleShortcutSubmit}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <span className="badge">Distribute</span>
      <p className="sr-only" id="distribute-shortcut-hint">Press Control Enter or Command Enter to submit this form.</p>

      {draftPrompt && (
        <div className="restore-prompt" role="status">
          <div>
            <strong>Restore previous session?</strong>
            <p>Saved token and amount values are available for this contract.</p>
          </div>
          <div className="restore-actions">
            <button type="button" className="btn-primary" onClick={restoreDraft} disabled={loading}>
              Restore
            </button>
            <button type="button" className="btn-secondary" onClick={discardDraft} disabled={loading}>
              Discard
            </button>
          </div>
        </div>
      )}

      {/* #391: Transaction status badge — shows optimistic state with phase progress */}
      {txEntry && txEntry.phase !== "idle" && (
        <TransactionStatusBadge
          entry={txEntry}
          network={network}
          onDismiss={resetTx}
        />
      )}

      <label htmlFor="distribute-token-id">Token contract address</label>
      <div className="input-wrapper">
        <input
          id="distribute-token-id"
          placeholder="C..."
          value={tokenId}
          autoComplete="off"
          spellCheck={false}
          disabled={loading}
          className={getFieldInputClass(tokenIdFieldState)}
          aria-invalid={getAriaInvalid(tokenIdFieldState)}
          aria-describedby={tokenIdError ? "distribute-token-id-error" : undefined}
          onChange={(e) => { setTokenId(e.target.value); setAmount(""); }}
          onBlur={handleTokenIdBlur}
          style={{ marginBottom: tokenIdError || tokenIdFieldState === "valid" ? "0.25rem" : undefined }}
        />
        {tokenIdFieldState === "valid" && (
          <span className="field-success" aria-hidden="true">
            Valid address
          </span>
        )}
      </div>
      {tokenIdError && (
        <p className="field-error" id="distribute-token-id-error" role="alert">
          {tokenIdError}
        </p>
      )}
      {tokenId && (
        <p className="description" id="contract-balance-status" aria-live="polite">
          {balanceLoading
            ? "Fetching balance…"
            : contractBalance !== null
            ? `Available balance: ${contractBalance}`
            : "Could not fetch balance."}
        </p>
      )}

      <label htmlFor="distribute-amount">Amount</label>
      <div className="input-wrapper">
        <input
          id="distribute-amount"
          type="text"
          inputMode="decimal"
          placeholder="0"
          value={amount}
          className={getFieldInputClass(exceedsBalance ? "error" : amountFieldState)}
          onChange={(e) => setAmount(e.target.value)}
          onBlur={handleAmountBlur}
          disabled={contractBalance === null || loading}
          aria-invalid={exceedsBalance ? "true" : getAriaInvalid(amountFieldState)}
          aria-describedby={exceedsBalance ? "distribute-amount-error" : amountFieldState === "error" ? "distribute-amount-validation" : undefined}
          style={{ marginBottom: exceedsBalance || (amountFieldState === "error" && !exceedsBalance) || amountFieldState === "valid" ? "0.25rem" : undefined }}
        />
        {amountFieldState === "valid" && !exceedsBalance && (
          <span className="field-success" aria-hidden="true">
            Valid amount
          </span>
        )}
      </div>
      {exceedsBalance && (
        <p
          className="field-error"
          id="distribute-amount-error"
        >
          Amount exceeds available balance of {contractBalance}.
        </p>
      )}
      {!exceedsBalance && amountFieldState === "error" && amountValue && (
        <p
          className="field-error"
          id="distribute-amount-validation"
          role="alert"
        >
          {getAmountValidationError(amountValue)}
        </p>
      )}
      {collaboratorsLoading && (
        <p className="description" aria-live="polite">Loading recipients…</p>
      )}
      {recipientBreakdown.length > 0 && (
        <div className="recipient-preview" aria-label="Recipient breakdown preview">
          <div className="recipient-preview__header">
            <span>Recipient breakdown</span>
            <span>{formatXlmAmount(parsedAmount)} XLM</span>
          </div>
          <div className="recipient-preview__list">
            {recipientBreakdown.map((recipient) => (
              <div className="recipient-preview__row" key={recipient.address}>
                <span title={recipient.address}>{shortAddress(recipient.address)}</span>
                <span>{recipient.basisPoints / 100}%</span>
                <strong>{formatXlmAmount(recipient.payout)} XLM</strong>
              </div>
            ))}
          </div>
          {totalBasisPoints !== 10_000 && (
            <p className="field-error">
              Recipient shares total {totalBasisPoints} basis points.
            </p>
          )}
        </div>
      )}

      <p className="description">Distributes the specified amount to all collaborators.</p>

      {networkMismatch && (
        <div className="status error" role="alert">
          Your wallet is on the wrong network. Switch it to {network === "mainnet" ? "Mainnet" : "Testnet"} to distribute funds.
        </div>
      )}
      <div className="form-actions">
        <button
          type="submit"
          className="btn-primary btn-with-spinner"
          data-testid="distribute-submit"
          disabled={loading || txLifecycle.isActive || exceedsBalance || !amount || !tokenIdValid || networkMismatch}
          aria-busy={loading || txLifecycle.isActive}
        >
          {(loading || txLifecycle.isActive) && <span className="btn-spinner" aria-hidden="true" />}
          {loading || txLifecycle.isActive ? "Submitting…" : "Distribute funds"}
        </button>
        <button
          type="button"
          className="btn-secondary"
          onClick={clearForm}
          data-testid="distribute-clear"
          disabled={loading || txLifecycle.isActive || (!tokenId && !amount && !draftPrompt)}
        >
          Clear
        </button>
      </div>

      {/* #653 — granular wallet/tx lifecycle feedback */}
      <TransactionStatusBanner
        stage={txLifecycle.state.stage}
        errorMessage={txLifecycle.state.errorMessage}
        txHash={txLifecycle.state.txHash}
        network={network}
        onRetry={txLifecycle.retry}
        onDismiss={txLifecycle.reset}
      />

      {status && (
        <FormStatus
          type={status.type}
          message={status.message}
          txHash={txEntry?.txHash ?? undefined}
          network={network}
          distributionData={
            status.type === "ok"
              ? {
                  totalDistributed: parsedAmount,
                  recipientCount: collaborators.length,
                }
              : undefined
          }
        />
      )}
    </form>
  );
}
