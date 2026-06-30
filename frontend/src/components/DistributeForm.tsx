import { useState, useEffect, useMemo, useRef } from "react";
import { api, type PauseState } from "../api";
import { getContractAddressError, isValidContractAddress } from "../lib/stellar-address";
import { signAndSubmitTransaction } from "../stellar";
import { useNetwork } from "../context/NetworkContext";
import { useTransaction, useIsTransactionInFlight } from "../context/TransactionContext";
import { useTransactionPolling } from "../hooks/useTransactionPolling";
import FormStatus from "./FormStatus";
import FormInput from "./FormInput";
import PauseBanner from "./PauseBanner";
import TransactionStatusBadge from "./TransactionStatusBadge";
import { useFormStatus } from "../hooks/useFormStatus";
import {
  runWithDistributionRetry,
  CircuitOpenError,
} from "../lib/distributionRetry";

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
  const { network } = useNetwork();
  const { current: txEntry, beginTransaction, updatePhase, reset: resetTx } = useTransaction();
  const isInFlight = useIsTransactionInFlight();
  // #414: real-time confirmation polling (5s interval, 60s timeout, aborts on unmount).
  const { poll: pollTransaction } = useTransactionPolling();

  const [tokenId, setTokenId] = useState("");
  const [amount, setAmount] = useState("");
  const [contractBalance, setContractBalance] = useState<string | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [collaborators, setCollaborators] = useState<CollaboratorShare[]>([]);
  const [collaboratorsLoading, setCollaboratorsLoading] = useState(false);
  const [draftPrompt, setDraftPrompt] = useState<DistributionDraft | null>(null);
  const [draftDecisionMade, setDraftDecisionMade] = useState(false);
  // #504: contract pause state — gates distribution and drives the banner.
  const [pauseState, setPauseState] = useState<PauseState | null>(null);
  // #502: auto-retry countdown surfaced to the user during a transient failure.
  const [retryInfo, setRetryInfo] = useState<{ attempt: number; secondsLeft: number } | null>(null);
  const retryAbortRef = useRef<AbortController | null>(null);
  const { status, setStatus, clearStatus } = useFormStatus();

  // Use TransactionContext's in-flight flag as the primary loading gate (#391)
  const loading = isInFlight;

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

  // #504: fetch pause state whenever the contract changes.
  useEffect(() => {
    if (!contractId) {
      setPauseState(null);
      return;
    }
    let cancelled = false;
    api
      .getPauseState(contractId)
      .then((state) => {
        if (!cancelled) setPauseState(state);
      })
      .catch(() => {
        // Treat an unreachable pause check as "not paused" — never block the
        // form purely because the read failed.
        if (!cancelled) setPauseState(null);
      });
    return () => {
      cancelled = true;
    };
  }, [contractId]);

  // #502: tick down the visible retry countdown once per second.
  useEffect(() => {
    if (!retryInfo || retryInfo.secondsLeft <= 0) return;
    const id = setInterval(() => {
      setRetryInfo((info) =>
        info ? { ...info, secondsLeft: Math.max(0, info.secondsLeft - 1) } : info,
      );
    }, 1000);
    return () => clearInterval(id);
  }, [retryInfo]);

  // #502: abort any in-flight retry loop on unmount.
  useEffect(() => {
    return () => retryAbortRef.current?.abort();
  }, []);

  const isPaused = pauseState?.paused ?? false;

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

  async function submit() {
    // #391: Don't resubmit if already in-flight
    if (isInFlight) return;

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
    // #504: never let a user sign a tx the contract will reject while paused.
    if (isPaused)
      return setStatus("error", "Contract is paused. Distributions are disabled.");

    // #391: Begin optimistic transaction state
    beginTransaction();

    // #502: retry the (idempotent) build step with backoff so a transient
    // network error doesn't force a manual — and possibly duplicate — resubmit.
    const abort = new AbortController();
    retryAbortRef.current = abort;

    try {
      const res = await runWithDistributionRetry(
        () =>
          api.distribute({
            contractId,
            walletAddress,
            tokenId,
            amount: parsedAmount,
          }),
        {
          signal: abort.signal,
          onRetry: (attempt, delayMs) => {
            setRetryInfo({ attempt, secondsLeft: Math.ceil(delayMs / 1000) });
            updatePhase("building", { error: `Network issue — retry ${attempt} in progress…` });
          },
        },
      );
      setRetryInfo(null);

      // #391: Phase 2 — signing
      updatePhase("signing", { transactionId: res.transactionId });

      const hash = await signAndSubmitTransaction(res.xdr, network);

      // #391/#414: Phase 3 — confirming, with countdown + real-time polling.
      updatePhase("confirming", { txHash: hash });

      // Kick off server-side settlement (Horizon polling + webhooks). We don't
      // block on it — the polling loop below reflects status in real time and
      // enforces the 60s client-side timeout independently.
      void api
        .confirmTransaction(hash, {
          status: "confirmed",
          blockTime: new Date().toISOString(),
          transactionId: res.transactionId,
        }, walletAddress)
        .catch(() => {
          // Settlement errors surface through the polled status / timeout.
        });

      // #414: poll GET /transaction/:hash every 5s until terminal or 60s.
      const outcome = await pollTransaction(hash);

      // Component unmounted mid-poll — nothing to update.
      if (outcome === "aborted") return;

      if (outcome === "confirmed") {
        // #391: Phase 4 — confirmed
        updatePhase("confirmed");
        setStatus("ok", "Distributed successfully.");
        localStorage.removeItem(draftKey);
        setTokenId("");
        setAmount("");
        onSuccess();
        return;
      }

      if (outcome === "timeout") {
        updatePhase("timeout", {
          error: "Confirmation timed out. The transaction may still settle.",
        });
        setStatus(
          "error",
          "Confirmation timed out. Check the transaction status shortly.",
        );
        return;
      }

      // outcome === "failed"
      updatePhase("failed", { error: "Transaction failed to confirm." });
      setStatus("error", "Transaction failed to confirm.");
    } catch (e: unknown) {
      setRetryInfo(null);

      // #502: a manual cancel / unmount aborts the retry loop — not a failure.
      if (e instanceof Error && e.name === "AbortError") {
        return;
      }

      // #502: circuit breaker tripped after repeated failures.
      if (e instanceof CircuitOpenError) {
        updatePhase("failed", { error: e.message });
        setStatus("error", e.message);
        return;
      }

      const msg = e instanceof Error ? e.message : "Unknown error";
      const isTimeout =
        msg.toLowerCase().includes("timeout") ||
        msg.toLowerCase().includes("timed out");

      // #391: Handle timeout scenario gracefully
      updatePhase(isTimeout ? "timeout" : "failed", { error: msg });
      setStatus("error", msg);
    } finally {
      retryAbortRef.current = null;
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

  function clearForm() {
    setTokenId("");
    setAmount("");
    setContractBalance(null);
    setDraftPrompt(null);
    setDraftDecisionMade(true);
    localStorage.removeItem(draftKey);
    clearStatus();
    resetTx();
  }

  return (
    <form
      className="card"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <span className="badge">Distribute</span>

      {/* #504: warn + block while the contract is paused. */}
      {pauseState && <PauseBanner pauseState={pauseState} />}

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

      <FormInput
        id="distribute-token-id"
        label="Token contract address"
        placeholder="C..."
        value={tokenId}
        error={tokenIdError ?? undefined}
        showSuccess={tokenIdValid && !tokenIdError}
        autoComplete="off"
        spellCheck={false}
        disabled={loading}
        onChange={(e) => { setTokenId(e.target.value); setAmount(""); }}
      />
      {tokenId && (
        <p className="description" id="contract-balance-status" aria-live="polite">
          {balanceLoading
            ? "Fetching balance…"
            : contractBalance !== null
            ? `Available balance: ${contractBalance}`
            : "Could not fetch balance."}
        </p>
      )}

      <FormInput
        id="distribute-amount"
        label="Amount"
        type="text"
        inputMode="decimal"
        placeholder="0"
        value={amount}
        error={exceedsBalance ? `Amount exceeds available balance of ${contractBalance}` : undefined}
        showSuccess={Boolean(amount) && !isNaN(parsedAmount) && parsedAmount > 0 && !exceedsBalance}
        onChange={(e) => setAmount(e.target.value)}
        disabled={contractBalance === null || loading}
      />
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

      {/* #502: surface the auto-retry countdown so the user waits instead of resubmitting. */}
      {retryInfo && (
        <p className="description" role="status" aria-live="polite" data-testid="retry-status">
          {retryInfo.secondsLeft > 0
            ? `Network issue — retrying (attempt ${retryInfo.attempt}) in ${retryInfo.secondsLeft}s…`
            : `Network issue — retrying (attempt ${retryInfo.attempt})…`}
        </p>
      )}

      <div className="form-actions">
        <button
          type="submit"
          className="btn-primary btn-with-spinner"
          disabled={loading || exceedsBalance || !amount || !tokenIdValid || isPaused}
          aria-busy={loading}
          data-testid="distribute-submit"
        >
          {loading && <span className="btn-spinner" aria-hidden="true" />}
          {isPaused ? "Contract paused" : loading ? "Submitting…" : "Distribute funds"}
        </button>
        <button
          type="button"
          className="btn-secondary"
          onClick={clearForm}
          disabled={loading || (!tokenId && !amount && !draftPrompt)}
          data-testid="distribute-clear"
        >
          Clear
        </button>
      </div>

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
