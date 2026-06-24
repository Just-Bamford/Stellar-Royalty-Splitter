import { useEffect, useMemo, useState } from "react";
import { useForm, SubmitHandler } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { api } from "../api";
import { useNetwork } from "../context/NetworkContext";
import { useFormStatus } from "../hooks/useFormStatus";
import { signAndSubmitTransaction } from "../stellar";
import FormStatus from "./FormStatus";
import { distributeFormSchema } from "../schemas/royaltySchemas";

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
  const [contractBalance, setContractBalance] = useState<string | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [collaborators, setCollaborators] = useState<CollaboratorShare[]>([]);
  const [collaboratorsLoading, setCollaboratorsLoading] = useState(false);
  const [draftPrompt, setDraftPrompt] = useState<DistributionDraft | null>(null);
  const [draftDecisionMade, setDraftDecisionMade] = useState(false);
  const { status, setStatus, clearStatus } = useFormStatus();
  const [successTxHash, setSuccessTxHash] = useState<string | null>(null);
  const draftKey = useMemo(
    () => `${DRAFT_KEY_PREFIX}:${walletAddress}:${contractId || "no-contract"}`,
    [contractId, walletAddress],
  );

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors, isSubmitting },
    reset,
    setValue,
  } = useForm({
    resolver: zodResolver(distributeFormSchema),
    defaultValues: { tokenId: "", amount: "" },
    mode: "onChange",
  });

  const tokenId = watch("tokenId");
  const amount = watch("amount");

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

  const parsedAmount = typeof amount === "string" ? parseFloat(amount) : amount;
  const parsedBalance = contractBalance !== null ? parseFloat(contractBalance) : null;
  const exceedsBalance =
    parsedBalance !== null && !isNaN(parsedAmount) && parsedAmount > parsedBalance;

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

  const onSubmit: SubmitHandler<any> = async (data: any) => {
    if (!contractId) {
      return setStatus("error", "Enter a contract ID first.");
    }

    if (exceedsBalance) {
      return setStatus("error", "Amount exceeds contract balance.");
    }

    setStatus("info", "Building transaction…");

    try {
      const res = await api.distribute({
        contractId,
        walletAddress,
        tokenId: data.tokenId,
      });

      setStatus("info", "Signing transaction with Freighter...");
      const hash = await signAndSubmitTransaction(res.xdr, network);

      setStatus("info", "Waiting for confirmation...");
      await api.confirmTransaction(hash, {
        status: "confirmed",
        blockTime: new Date().toISOString(),
        transactionId: res.transactionId,
      });

      setSuccessTxHash(hash);
      setStatus("ok", "Distributed successfully.");
      localStorage.removeItem(draftKey);
      reset();
      onSuccess();
    } catch (e: unknown) {
      setStatus("error", e instanceof Error ? e.message : "Unknown error");
    }
  };

  function restoreDraft() {
    if (!draftPrompt) return;
    setValue("tokenId", draftPrompt.tokenId);
    setValue("amount", draftPrompt.amount as any);
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
    reset();
    setContractBalance(null);
    setDraftPrompt(null);
    setDraftDecisionMade(true);
    setSuccessTxHash(null);
    localStorage.removeItem(draftKey);
    clearStatus();
  }

  return (
    <form
      className="card"
      onSubmit={handleSubmit(onSubmit)}
    >
      <span className="badge">Distribute</span>

      {draftPrompt && (
        <div className="restore-prompt" role="status">
          <div>
            <strong>Restore previous session?</strong>
            <p>Saved token and amount values are available for this contract.</p>
          </div>
          <div className="restore-actions">
            <button
              type="button"
              className="btn-primary"
              onClick={restoreDraft}
              disabled={isSubmitting}
            >
              Restore
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={discardDraft}
              disabled={isSubmitting}
            >
              Discard
            </button>
          </div>
        </div>
      )}

      <label htmlFor="distribute-token-id">Token contract address</label>
      <input
        id="distribute-token-id"
        placeholder="C..."
        {...register("tokenId")}
        autoComplete="off"
        spellCheck={false}
        disabled={isSubmitting}
        aria-invalid={errors.tokenId ? "true" : undefined}
        aria-describedby={errors.tokenId ? "distribute-token-id-error" : undefined}
      />
      {errors.tokenId && (
        <p className="field-error" id="distribute-token-id-error" role="alert">
          {errors.tokenId.message}
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
      <input
        id="distribute-amount"
        type="text"
        inputMode="decimal"
        placeholder="0"
        {...register("amount")}
        disabled={contractBalance === null || isSubmitting}
        aria-invalid={exceedsBalance || errors.amount ? "true" : undefined}
        aria-describedby={
          exceedsBalance || errors.amount ? "distribute-amount-error" : undefined
        }
      />
      {errors.amount && (
        <p className="field-error" id="distribute-amount-error" role="alert">
          {errors.amount.message}
        </p>
      )}
      {exceedsBalance && (
        <p className="field-error" id="distribute-amount-error" role="alert">
          Amount exceeds available balance of {contractBalance}.
        </p>
      )}

      {collaboratorsLoading && (
        <p className="description" aria-live="polite">
          Loading recipients…
        </p>
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
      <div className="form-actions">
        <button
          type="submit"
          className="btn-primary btn-with-spinner"
          disabled={isSubmitting || exceedsBalance || Object.keys(errors).length > 0}
          aria-busy={isSubmitting}
        >
          {isSubmitting && <span className="btn-spinner" aria-hidden="true" />}
          {isSubmitting ? "Submitting…" : "Distribute funds"}
        </button>
        <button
          type="button"
          className="btn-secondary"
          onClick={clearForm}
          disabled={isSubmitting || (!tokenId && !amount && !draftPrompt)}
        >
          Clear
        </button>
      </div>
      {status && (
        <FormStatus
          type={status.type}
          message={status.message}
          txHash={successTxHash ?? undefined}
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
