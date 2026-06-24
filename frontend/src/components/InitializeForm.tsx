import React from "react";
import { useForm, useFieldArray, SubmitHandler } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { api } from "../api";
import { useNetwork } from "../context/NetworkContext";
import { useFormStatus } from "../hooks/useFormStatus";
import { signAndSubmitTransaction } from "../stellar";
import FormStatus from "./FormStatus";
import { initializeFormSchema, type InitializeFormData } from "../schemas/royaltySchemas";

interface Props {
  contractId: string;
  walletAddress: string;
  onSuccess: () => void;
}

const MAX_COLLABORATORS = 50;
const PERCENTAGE_NAVIGATION_KEYS = [
  "Backspace",
  "Delete",
  "Tab",
  "Escape",
  "Enter",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
];

function handlePercentageKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
  if (
    event.ctrlKey ||
    event.metaKey ||
    PERCENTAGE_NAVIGATION_KEYS.includes(event.key)
  ) {
    return;
  }

  if (!/^[0-9.]$/.test(event.key)) {
    event.preventDefault();
    return;
  }

  if (event.key === "." && event.currentTarget.value.includes(".")) {
    event.preventDefault();
  }
}

export default function InitializeForm({
  contractId,
  walletAddress,
  onSuccess,
}: Props) {
  const { network } = useNetwork();
  const { status, setStatus } = useFormStatus();

  const {
    register,
    handleSubmit,
    control,
    watch,
    formState: { errors, isSubmitting },
    reset,
  } = useForm<InitializeFormData>({
    resolver: zodResolver(initializeFormSchema),
    defaultValues: {
      collaborators: [{ address: "", basisPoints: "" as any }],
    },
    mode: "onChange",
  });

  const { fields, append, remove } = useFieldArray({
    control,
    name: "collaborators",
  });

  const collaborators = watch("collaborators");
  const total = collaborators.reduce(
    (sum: number, c: any) => sum + (typeof c.basisPoints === "string" ? parseFloat(c.basisPoints) : c.basisPoints || 0),
    0,
  );

  const hasErrors = Object.keys(errors).length > 0;

  const onSubmit: SubmitHandler<any> = async (data) => {
    if (!contractId) {
      return setStatus("error", "Enter a contract ID first.");
    }

    setStatus("info", "Building transaction…");

    try {
      // Check for duplicate addresses
      const addresses = data.collaborators.map((c: any) => c.address);
      const hasDuplicates = new Set(addresses).size !== addresses.length;
      if (hasDuplicates) {
        return setStatus("error", "Duplicate addresses are not allowed.");
      }

      const res = await api.initialize({
        contractId,
        walletAddress,
        collaborators: addresses,
        shares: data.collaborators.map((c: any) =>
          Math.round(
            (typeof c.basisPoints === "string" ? parseFloat(c.basisPoints) : c.basisPoints) * 100
          )
        ),
      });

      setStatus("info", "Signing transaction with Freighter...");
      const hash = await signAndSubmitTransaction(res.xdr, network);

      setStatus("info", "Waiting for confirmation...");
      await api.confirmTransaction(hash, {
        status: "confirmed",
        blockTime: new Date().toISOString(),
      });

      setStatus("ok", `Initialized. Tx: ${hash}`);
      reset();
      onSuccess();
    } catch (e: unknown) {
      const errorMessage = e instanceof Error ? e.message : "Unknown error";
      if (errorMessage.includes("409") || errorMessage.includes("already initialized")) {
        setStatus(
          "error",
          "⚠️ This contract is already initialized. You cannot re-initialize an existing contract."
        );
      } else {
        setStatus("error", errorMessage);
      }
    }
  };

  return (
    <div className="card">
      <span className="badge">Initialize</span>

      <form onSubmit={handleSubmit(onSubmit)}>
        {fields.map((field: any, i: number) => (
          <div key={field.id}>
            <div className="collaborator-row">
              <div style={{ flex: 3, display: "flex", flexDirection: "column" }}>
                <input
                  placeholder="Wallet address (G...)"
                  {...register(`collaborators.${i}.address`)}
                  disabled={isSubmitting}
                  aria-invalid={Boolean(errors.collaborators?.[i]?.address)}
                  aria-describedby={
                    errors.collaborators?.[i]?.address ? `collaborator-${i}-address-error` : undefined
                  }
                />
                {errors.collaborators?.[i]?.address && (
                  <span
                    id={`collaborator-${i}-address-error`}
                    className="field-error"
                    role="alert"
                  >
                    {errors.collaborators[i]?.address?.message}
                  </span>
                )}
              </div>
              <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
                <input
                  placeholder="% (0–100)"
                  type="number"
                  min={0}
                  max={100}
                  step="any"
                  {...register(`collaborators.${i}.basisPoints`)}
                  disabled={isSubmitting}
                  onKeyDown={handlePercentageKeyDown}
                  aria-label={`Royalty percentage for collaborator ${i + 1}`}
                  aria-invalid={Boolean(errors.collaborators?.[i]?.basisPoints)}
                  aria-describedby={
                    errors.collaborators?.[i]?.basisPoints ? `collaborator-${i}-percentage-error` : undefined
                  }
                />
                {errors.collaborators?.[i]?.basisPoints && (
                  <span
                    id={`collaborator-${i}-percentage-error`}
                    className="field-error"
                    role="alert"
                  >
                    {errors.collaborators[i]?.basisPoints?.message}
                  </span>
                )}
              </div>
              {fields.length > 1 && (
                <button
                  type="button"
                  className="btn-danger"
                  onClick={() => remove(i)}
                  disabled={isSubmitting}
                  aria-label={`Remove collaborator ${i + 1}`}
                >
                  ✕
                </button>
              )}
            </div>
          </div>
        ))}

        <div
          className={`share-total ${Math.round(total * 100) === 10_000 ? "share-total--valid" : "share-total--invalid"}`}
          role="status"
          aria-live="polite"
          aria-label={`Share total: ${total.toFixed(2)}% of 100% required`}
          data-testid="share-total"
        >
          Total: {total.toFixed(2)}% / 100%
          {Math.round(total * 100) !== 10_000 && total > 0 && (
            <span className="share-total__hint" aria-hidden="true">
              {" "}({Math.round(total * 100) < 10_000 ? `${(100 - total).toFixed(2)}% remaining` : `${(total - 100).toFixed(2)}% over`})
            </span>
          )}
        </div>

        {errors.collaborators?.root && (
          <div className="field-error" role="alert">
            {errors.collaborators.root.message}
          </div>
        )}

        {fields.length >= MAX_COLLABORATORS - 5 && fields.length < MAX_COLLABORATORS && (
          <div className="status info">
            Approaching the limit — max {MAX_COLLABORATORS} collaborators allowed ({MAX_COLLABORATORS - fields.length} remaining).
          </div>
        )}
        {fields.length >= MAX_COLLABORATORS && (
          <div className="status error">
            Maximum of {MAX_COLLABORATORS} collaborators reached. Remove one to add another.
          </div>
        )}

        <div className="row">
          <button
            type="button"
            className="btn-add"
            onClick={() => append({ address: "", basisPoints: "" as any })}
            disabled={fields.length >= MAX_COLLABORATORS || isSubmitting}
          >
            + Add collaborator
          </button>
          <button
            type="submit"
            className="btn-primary"
            disabled={isSubmitting || hasErrors}
            aria-busy={isSubmitting}
          >
            {isSubmitting ? "Submitting…" : "Initialize contract"}
          </button>
        </div>
      </form>

      {status && <FormStatus type={status.type} message={status.message} />}
    </div>
  );
}
