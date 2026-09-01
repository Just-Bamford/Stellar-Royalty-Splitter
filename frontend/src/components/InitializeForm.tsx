import React, { useState, useEffect, useCallback, useRef } from "react";
import { api, RoyaltyTemplate, RoyaltyTemplateAllocation } from "../api";
import { signAndSubmitTransaction } from "../stellar";
import { useNetwork } from "../context/NetworkContext";
import FormStatus from "./FormStatus";
import { RoyaltyPayoutPreview } from "./RoyaltyPayoutPreview";
import ValidationSummary, {
  type ValidationSummaryIssue,
} from "./ValidationSummary";
import { useFormStatus } from "../hooks/useFormStatus";
import { useRoyaltyDraft } from "../hooks/useRoyaltyDraft";
import {
  parseRoyaltyConfigImport,
  RoyaltyConfigImportError,
  buildRoyaltyConfigExport,
  downloadRoyaltyConfig,
  RoyaltyConfigExportError,
} from "../utils/royaltyConfig";
import {
  isValidAccountAddress,
  getAccountAddressError,
  getPercentageValidationError,
  formatBasisPoints,
  getFieldState,
  getFieldInputClass,
  getAriaInvalid,
  type FieldState,
} from "../lib/formValidation";

interface Collaborator {
  address: string;
  basisPoints: string;
}

interface Props {
  contractId: string;
  walletAddress: string;
  onSuccess: () => void;
}

const MAX_COLLABORATORS = 50;
const PERCENTAGE_INPUT_RE = /^(\d+(\.\d*)?|\.\d+)?$/;
const SIGNED_PERCENTAGE_INPUT_RE = /^-(\d+(\.\d*)?|\.\d+)$/;
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

function getPercentageError(value: string): string {
  return getPercentageValidationError(value) ?? "";
}

function isAllowedPercentageInput(value: string) {
  return PERCENTAGE_INPUT_RE.test(value);
}

/**
 * Mirrors the backend's template allocation validation (#652) so a
 * template can be checked both before it's saved and again before it's
 * applied to the form (templates are app-level data and could in theory
 * have been created under different rules).
 */
function validateTemplateAllocations(allocations: RoyaltyTemplateAllocation[]) {
  const addresses = allocations.map((a) => a.address);
  if (new Set(addresses).size !== addresses.length) {
    return "Duplicate collaborator addresses are not allowed.";
  }
  const totalPct = allocations.reduce((sum, a) => sum + a.percentage, 0);
  if (Math.round(totalPct * 100) !== 10_000) {
    return `Percentages must sum to 100% (got ${totalPct.toFixed(2)}%).`;
  }
  return null;
}

function updatePercentageError(
  setErrors: React.Dispatch<
    React.SetStateAction<
      Record<number, { address?: string; basisPoints?: string }>
    >
  >,
  i: number,
  error: string,
) {
  setErrors((prev) => ({
    ...prev,
    [i]: {
      ...prev[i],
      basisPoints: error,
    },
  }));
}

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
  const { network, networkMismatch } = useNetwork();
  const [collaborators, setCollaborators] = useState<Collaborator[]>([
    { address: "", basisPoints: "" },
  ]);
  const { status, setStatus } = useFormStatus();
  const [loading, setLoading] = useState(false);
  const [pendingCommit, setPendingCommit] = useState<{
    collaborators: string[];
    shares: number[];
  } | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const addressRefs = useRef<(HTMLInputElement | null)[]>([]);
  const percentageRefs = useRef<(HTMLInputElement | null)[]>([]);
  const [errors, setErrors] = useState<
    Record<number, { address?: string; basisPoints?: string }>
  >({});
  const [touched, setTouched] = useState<
    Record<number, { address?: boolean; basisPoints?: boolean }>
  >({});

  const restoreDraft = useCallback((draftCollaborators: Collaborator[]) => {
    setCollaborators(draftCollaborators);
    setErrors({});
  }, []);

  const {
    pendingDraft,
    acceptDraft,
    discardDraft,
    clearSavedDraft,
    saving: draftSaving,
    savedAt: draftSavedAt,
  } = useRoyaltyDraft(collaborators, restoreDraft);

  function triggerImport() {
    importInputRef.current?.click();
  }

  async function handleImportFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // Allow re-selecting the same file after a failed import.
    event.target.value = "";
    if (!file) return;

    try {
      const text = await file.text();
      const imported = parseRoyaltyConfigImport(text);
      setCollaborators(imported);
      setErrors({});
      setStatus(
        "ok",
        `Imported ${imported.length} collaborator(s) from ${file.name}.`,
      );
    } catch (e: unknown) {
      if (e instanceof RoyaltyConfigImportError) {
        setStatus("error", e.errors.join(" "));
      } else {
        setStatus("error", "Could not read the selected file.");
      }
    }
  }

  function handleExport() {
    try {
      const config = buildRoyaltyConfigExport(
        collaborators,
        new Date().toISOString(),
      );
      const suffix = contractId ? contractId.slice(0, 8) : "draft";
      downloadRoyaltyConfig(config, `royalty-split-${suffix}.json`);
      setStatus("ok", "Exported royalty split configuration.");
    } catch (e: unknown) {
      if (e instanceof RoyaltyConfigExportError) {
        setStatus("error", e.errors.join(" "));
      } else {
        setStatus("error", "Could not export the current configuration.");
      }
    }
  }

  // Reusable royalty split templates (#652)
  const [templates, setTemplates] = useState<RoyaltyTemplate[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [templatesError, setTemplatesError] = useState<string | null>(null);
  const [templateName, setTemplateName] = useState("");
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [templateStatus, setTemplateStatus] = useState<{
    type: "ok" | "error";
    message: string;
  } | null>(null);

  const fetchTemplates = useCallback(() => {
    if (!walletAddress || typeof api.listTemplates !== "function") return;
    setTemplatesLoading(true);
    setTemplatesError(null);
    const templatesRequest = api.listTemplates(walletAddress);
    if (!templatesRequest || typeof templatesRequest.then !== "function") {
      setTemplatesLoading(false);
      return;
    }
    templatesRequest
      .then((res) => setTemplates(res.data))
      .catch((e: unknown) =>
        setTemplatesError(
          e instanceof Error ? e.message : "Failed to load templates",
        ),
      )
      .finally(() => setTemplatesLoading(false));
  }, [walletAddress]);

  useEffect(() => {
    fetchTemplates();
  }, [fetchTemplates]);

  function update(i: number, field: keyof Collaborator, value: string) {
    setCollaborators((prev: Collaborator[]) =>
      prev.map((c: Collaborator, idx: number) =>
        idx === i ? { ...c, [field]: value } : c,
      ),
    );
  }

  function addRow() {
    if (collaborators.length >= MAX_COLLABORATORS) return;
    setCollaborators((prev) => [...prev, { address: "", basisPoints: "" }]);
  }

  function removeRow(i: number) {
    setCollaborators((prev) =>
      prev.filter((_: Collaborator, idx: number) => idx !== i),
    );
  }

  async function saveAsTemplate() {
    setTemplateStatus(null);

    const name = templateName.trim();
    if (!name) {
      setTemplateStatus({
        type: "error",
        message: "Enter a name for the template.",
      });
      return;
    }
    if (hasErrors || hasEmptyFields || hasInvalidPercentages) {
      setTemplateStatus({
        type: "error",
        message:
          "Fix the collaborator allocation errors before saving as a template.",
      });
      return;
    }

    const allocations: RoyaltyTemplateAllocation[] = collaborators.map((c) => ({
      address: c.address,
      percentage: parseFloat(c.basisPoints),
    }));
    const allocationError = validateTemplateAllocations(allocations);
    if (allocationError) {
      setTemplateStatus({ type: "error", message: allocationError });
      return;
    }

    setSavingTemplate(true);
    try {
      await api.createTemplate({ walletAddress, name, allocations });
      setTemplateName("");
      setTemplateStatus({ type: "ok", message: `Saved template "${name}".` });
      fetchTemplates();
    } catch (e: unknown) {
      setTemplateStatus({
        type: "error",
        message: e instanceof Error ? e.message : "Failed to save template.",
      });
    } finally {
      setSavingTemplate(false);
    }
  }

  function applyTemplate(template: RoyaltyTemplate) {
    const allocationError = validateTemplateAllocations(template.allocations);
    if (allocationError) {
      setTemplateStatus({
        type: "error",
        message: `Cannot apply "${template.name}": ${allocationError}`,
      });
      return;
    }

    setCollaborators(
      template.allocations.map((a) => ({
        address: a.address,
        basisPoints: String(a.percentage),
      })),
    );
    setErrors({});
    setTemplateStatus({
      type: "ok",
      message: `Applied template "${template.name}".`,
    });
  }

  async function handleDeleteTemplate(id: number, name: string) {
    setTemplateStatus(null);
    try {
      await api.deleteTemplate(id, walletAddress);
      setTemplates((prev) => prev.filter((t) => t.id !== id));
      setTemplateStatus({ type: "ok", message: `Deleted template "${name}".` });
    } catch (e: unknown) {
      setTemplateStatus({
        type: "error",
        message: e instanceof Error ? e.message : "Failed to delete template.",
      });
    }
  }

  const total = collaborators.reduce(
    (sum: number, c: Collaborator) => sum + (parseFloat(c.basisPoints) || 0),
    0,
  );

  const allRowsCommitted = collaborators.every(
    (c) => c.address && c.basisPoints,
  );
  const hasEmptyFields = collaborators.some((c) => !c.address || !c.basisPoints);
  const hasInvalidPercentages = collaborators.some((c) =>
    Boolean(getPercentageError(c.basisPoints)),
  );
  const hasErrors = Object.values(errors).some((row) => row.address || row.basisPoints);
  const previewValid =
    !hasEmptyFields &&
    !hasInvalidPercentages &&
    !hasErrors &&
    Math.round(total * 100) === 10_000;
  const previewInvalidReason = previewValid
    ? ""
    : "Fix collaborator addresses and percentages before previewing payouts.";

  function validateRow(i: number, field: keyof Collaborator, value: string) {
    setErrors((prev) => {
      const next = { ...prev };
      const row = { ...(next[i] ?? {}) };
      if (field === "address") {
        row.address = getAccountAddressError(value) ?? undefined;
      } else {
        row.basisPoints = getPercentageValidationError(value) ?? undefined;
      }
      if (!row.address && !row.basisPoints) {
        delete next[i];
      } else {
        next[i] = row;
      }
      return next;
    });
  }

  function handleBlur(i: number, field: keyof Collaborator, value: string) {
    setTouched((prev) => ({
      ...prev,
      [i]: { ...prev[i], [field]: true },
    }));
    validateRow(i, field, value);
  }

  function getFieldStateForRow(i: number, field: keyof Collaborator): FieldState {
    const isTouched = touched[i]?.[field] ?? false;
    const error = errors[i]?.[field] ?? null;
    return getFieldState(isTouched, error);
  }

  // Issue #694 — one summary of every active validation issue, derived from
  // the same per-row (getPercentageError, shared Stellar address validation) and aggregate
  // (share total, duplicate address) checks submit() already runs, so there
  // is only one validation implementation.
  const validationIssues: ValidationSummaryIssue[] = [];
  collaborators.forEach((c: Collaborator, i: number) => {
    if (!c.address) {
      validationIssues.push({
        index: i,
        field: "address",
        message: `Collaborator ${i + 1}: wallet address is required.`,
      });
    } else if (!isValidAccountAddress(c.address)) {
      validationIssues.push({
        index: i,
        field: "address",
        message: `Collaborator ${i + 1}: must be a valid Stellar address (G..., 56 chars).`,
      });
    }

    const percentageError = getPercentageError(c.basisPoints);
    if (percentageError) {
      validationIssues.push({
        index: i,
        field: "basisPoints",
        message: `Collaborator ${i + 1}: ${percentageError}`,
      });
    }
  });
  {
    const seen = new Set<string>();
    collaborators.forEach((c: Collaborator, i: number) => {
      if (!c.address) return;
      if (seen.has(c.address)) {
        validationIssues.push({
          index: i,
          field: "address",
          message: `Collaborator ${i + 1}: duplicate address.`,
        });
      }
      seen.add(c.address);
    });
  }
  if (Math.round(total * 100) !== 10_000) {
    validationIssues.push({
      index: -1,
      field: "basisPoints",
      message: `Percentages must sum to 100% (currently ${total.toFixed(2)}%).`,
    });
  }

  function focusField(index: number, field: "address" | "basisPoints") {
    if (field === "address") {
      addressRefs.current[index]?.focus();
    } else {
      percentageRefs.current[index]?.focus();
    }
  }

  function handleShortcutSubmit(event: React.KeyboardEvent<HTMLDivElement>) {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      void submit();
    }
  }

  async function submit() {
    if (networkMismatch)
      return setStatus(
        "error",
        "Your wallet is on the wrong network. Switch it before submitting.",
      );
    if (!contractId) return setStatus("error", "Enter a contract ID first.");

    const nextErrors = collaborators.reduce<
      Record<number, { address?: string; basisPoints?: string }>
    >((acc, c, i) => {
      if (!c.address || !isValidAccountAddress(c.address)) {
        acc[i] = {
          ...acc[i],
          address: "Must be a valid Stellar address (G..., 56 chars)",
        };
      }
      const percentageError = getPercentageError(c.basisPoints);
      if (percentageError) {
        acc[i] = { ...acc[i], basisPoints: percentageError };
      }
      return acc;
    }, {});

    if (Object.keys(nextErrors).length > 0) {
      setErrors((prev) => ({ ...prev, ...nextErrors }));
      const firstErrorIdx = Object.keys(nextErrors)
        .map(Number)
        .sort((a, b) => a - b)[0];
      if (firstErrorIdx !== undefined) {
        const fieldErrors = nextErrors[firstErrorIdx];
        if (fieldErrors?.address) {
          addressRefs.current[firstErrorIdx]?.focus();
        } else if (fieldErrors?.basisPoints) {
          percentageRefs.current[firstErrorIdx]?.focus();
        }
      }
      return setStatus(
        "error",
        "Please fix all field errors before submitting.",
      );
    }

    if (Math.round(total * 100) !== 10_000)
      return setStatus(
        "error",
        `Percentages must sum to 100% (currently ${total.toFixed(2)}%).`,
      );

    const addresses = collaborators.map((c: Collaborator) => c.address);
    const hasDuplicates = new Set(addresses).size !== addresses.length;
    if (hasDuplicates) {
      return setStatus("error", "Duplicate addresses are not allowed.");
    }

    const payload = {
      contractId,
      walletAddress,
      collaborators: pendingCommit?.collaborators ?? addresses,
      shares:
        pendingCommit?.shares ??
        collaborators.map((c: Collaborator) =>
          Math.round(parseFloat(c.basisPoints) * 100),
        ),
    };

    setLoading(true);
    setStatus("info", pendingCommit ? "Building reveal transaction…" : "Building commitment transaction…");

    try {
      const res = pendingCommit
        ? await api.initializeReveal(payload)
        : await api.initializeCommit(payload);

      setStatus("info", "Signing transaction with Freighter...");
      const hash = await signAndSubmitTransaction(res.xdr, network);

      setStatus("info", "Waiting for confirmation...");
      await api.confirmTransaction(hash, {
        status: "confirmed",
        blockTime: new Date().toISOString(),
      });

      if (pendingCommit) {
        setPendingCommit(null);
        setStatus("ok", `Initialized. Tx: ${hash}`);
        onSuccess();
      } else {
        setPendingCommit({ collaborators: payload.collaborators, shares: payload.shares });
        setStatus("info", `Commitment confirmed. Wait for one ledger, then reveal it. Tx: ${hash}`);
      }
    } catch (e: unknown) {
      const errorMessage = e instanceof Error ? e.message : "Unknown error";
      if (
        errorMessage.includes("409") ||
        errorMessage.includes("already initialized")
      ) {
        setStatus(
          "error",
          "⚠️ This contract is already initialized. You cannot re-initialize an existing contract.",
        );
      } else {
        setStatus("error", errorMessage);
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="card" onKeyDown={handleShortcutSubmit} aria-describedby="initialize-shortcut-hint">
      <span className="badge">Initialize</span>
      <p className="sr-only" id="initialize-shortcut-hint">Press Control Enter or Command Enter to submit this form.</p>

      {pendingDraft && (
        <div
          className="status info"
          role="alert"
          aria-live="polite"
          data-testid="draft-restore-banner"
        >
          A saved draft from {new Date(pendingDraft.savedAt).toLocaleString()}{" "}
          was found.{" "}
          <button
            type="button"
            onClick={acceptDraft}
            style={{ marginRight: "0.5rem" }}
            data-testid="draft-restore-accept"
          >
            Restore draft
          </button>
          <button
            type="button"
            onClick={discardDraft}
            data-testid="draft-restore-discard"
          >
            Discard
          </button>
        </div>
      )}

      {(draftSaving || draftSavedAt) && (
        <div className="status info" role="status" aria-live="polite">
          {draftSaving
            ? "Saving draft..."
            : `Draft saved at ${new Date(draftSavedAt ?? "").toLocaleTimeString()}.`}{" "}
          <button type="button" onClick={clearSavedDraft}>
            Clear saved draft
          </button>
        </div>
      )}

      {collaborators.map((c: Collaborator, i: number) => (
        <div key={i}>
          <div className="collaborator-row">
            <div style={{ flex: 3, display: "flex", flexDirection: "column" }}>
              <label htmlFor={`collaborator-${i}-address`}>
                Collaborator {i + 1} wallet address
              </label>
              <div className="input-wrapper">
                <input
                  id={`collaborator-${i}-address`}
                  ref={(el) => {
                    addressRefs.current[i] = el;
                  }}
                  placeholder="Wallet address (G...)"
                  value={c.address}
                  className={getFieldInputClass(getFieldStateForRow(i, "address"))}
                  aria-invalid={getAriaInvalid(getFieldStateForRow(i, "address"))}
                  aria-describedby={
                    errors[i]?.address
                      ? `collaborator-${i}-address-error`
                      : undefined
                  }
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    update(i, "address", e.target.value)
                  }
                  onBlur={(e: React.FocusEvent<HTMLInputElement>) =>
                    handleBlur(i, "address", e.target.value)
                  }
                  style={{
                    marginBottom: errors[i]?.address || getFieldStateForRow(i, "address") === "valid" ? "0.25rem" : undefined,
                  }}
                />
                {getFieldStateForRow(i, "address") === "valid" && (
                  <span className="field-success" aria-hidden="true">
                    Valid address
                  </span>
                )}
              </div>
              {errors[i]?.address && (
                <span
                  id={`collaborator-${i}-address-error`}
                  className="field-error"
                  role="alert"
                >
                  {errors[i].address}
                </span>
              )}
            </div>
            <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
              <label htmlFor={`collaborator-${i}-percentage`}>
                Collaborator {i + 1} percentage
              </label>
              <div className="input-wrapper">
                <input
                  id={`collaborator-${i}-percentage`}
                  ref={(el) => {
                    percentageRefs.current[i] = el;
                  }}
                  placeholder="% (0–100)"
                  type="number"
                  min={0}
                  max={100}
                  step="any"
                  value={c.basisPoints}
                  className={`${getFieldInputClass(getFieldStateForRow(i, "basisPoints"))}${errors[i]?.basisPoints ? " input-error" : ""}`.trim()}
                  aria-invalid={getAriaInvalid(getFieldStateForRow(i, "basisPoints"))}
                  aria-describedby={
                    errors[i]?.basisPoints
                      ? `collaborator-${i}-percentage-error`
                      : undefined
                  }
                  onKeyDown={handlePercentageKeyDown}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                    const { value } = e.target;
                    if (!isAllowedPercentageInput(value)) {
                      updatePercentageError(
                        setErrors,
                        i,
                        getPercentageError(value),
                      );
                      return;
                    }
                    update(i, "basisPoints", value);
                    validateRow(i, "basisPoints", value);
                  }}
                  onBlur={(e: React.FocusEvent<HTMLInputElement>) =>
                    handleBlur(i, "basisPoints", e.target.value)
                  }
                  style={{
                    marginBottom: errors[i]?.basisPoints || getFieldStateForRow(i, "basisPoints") === "valid" ? "0.25rem" : undefined,
                  }}
                />
                {getFieldStateForRow(i, "basisPoints") === "valid" && (
                  <span className="field-success" aria-hidden="true">
                    Valid
                  </span>
                )}
              </div>
              {errors[i]?.basisPoints && (
                <span
                  id={`collaborator-${i}-percentage-error`}
                  className="field-error"
                  role="alert"
                >
                  {errors[i].basisPoints}
                </span>
              )}
            </div>
            {collaborators.length > 1 && (
              <button
                className="btn-danger"
                aria-label={`Remove collaborator ${i + 1}`}
                onClick={() => removeRow(i)}
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
            {" "}
            (
            {Math.round(total * 100) < 10_000
              ? `${(100 - total).toFixed(2)}% remaining`
              : `${(total - 100).toFixed(2)}% over`}
            )
          </span>
        )}
      </div>

      <RoyaltyPayoutPreview
        collaborators={collaborators}
        isValid={previewValid}
        invalidReason={previewInvalidReason}
      />
      <ValidationSummary issues={validationIssues} onFocusField={focusField} />

      {collaborators.length >= MAX_COLLABORATORS - 5 &&
        collaborators.length < MAX_COLLABORATORS && (
          <div className="status info">
            Approaching the limit — max {MAX_COLLABORATORS} collaborators
            allowed ({MAX_COLLABORATORS - collaborators.length} remaining).
          </div>
        )}
      {collaborators.length >= MAX_COLLABORATORS && (
        <div className="status error">
          Maximum of {MAX_COLLABORATORS} collaborators reached. Remove one to
          add another.
        </div>
      )}

      <div className="row">
        <button
          className="btn-add"
          onClick={addRow}
          disabled={collaborators.length >= MAX_COLLABORATORS}
          aria-label={`Add collaborator (${collaborators.length} of ${MAX_COLLABORATORS})`}
        >
          + Add collaborator
        </button>
        <button className="btn-add" type="button" onClick={triggerImport}>
          Import from JSON
        </button>
        <input
          ref={importInputRef}
          type="file"
          accept="application/json,.json"
          onChange={handleImportFile}
          style={{ display: "none" }}
        />
        <button className="btn-add" type="button" onClick={handleExport}>
          Export to JSON
        </button>
        <button
          className="btn-primary"
          onClick={submit}
          aria-busy={loading ? "true" : "false"}
          disabled={
            loading ||
            !allRowsCommitted ||
            hasErrors ||
            hasEmptyFields ||
            hasInvalidPercentages ||
            networkMismatch
          }
        >
          {loading
            ? "Submitting…"
            : pendingCommit
              ? "Reveal initialization"
              : "Initialize contract"}
        </button>
      </div>

      {pendingCommit && (
        <div className="status info" role="status" aria-live="polite">
          Initialization is committed. Submit the reveal after the next ledger.
        </div>
      )}

      {networkMismatch && (
        <div className="status error" role="alert">
          Your wallet is on the wrong network. Switch it to{" "}
          {network === "mainnet" ? "Mainnet" : "Testnet"} to initialize this
          contract.
        </div>
      )}
      <div className="sr-only" aria-live="assertive" aria-atomic="true">
        {status?.message ?? ""}
      </div>
      {status && <FormStatus type={status.type} message={status.message} />}
    </div>
  );
}
