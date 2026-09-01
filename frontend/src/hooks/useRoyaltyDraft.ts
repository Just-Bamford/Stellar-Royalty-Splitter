import { useCallback, useEffect, useRef, useState } from "react";
import { isValidStellarAccountAddress } from "../../../shared/stellar-address";

export const DRAFT_STORAGE_KEY = "srs_royalty_draft";
const AUTOSAVE_DELAY_MS = 5000;

export interface DraftCollaborator {
  address: string;
  basisPoints: string;
}

export interface RoyaltyDraft {
  collaborators: DraftCollaborator[];
  savedAt: string;
}

function isValidDraft(value: unknown): value is RoyaltyDraft {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.collaborators) || v.collaborators.length === 0) return false;
  if (typeof v.savedAt !== "string") return false;
  return v.collaborators.every(
    (c) =>
      typeof c === "object" &&
      c !== null &&
      typeof (c as Record<string, unknown>).address === "string" &&
      typeof (c as Record<string, unknown>).basisPoints === "string" &&
      isValidStellarAccountAddress((c as Record<string, unknown>).address),
  );
}

function loadDraft(): RoyaltyDraft | null {
  try {
    const raw = localStorage.getItem(DRAFT_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isValidDraft(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function saveDraft(collaborators: DraftCollaborator[]): void {
  try {
    const draft: RoyaltyDraft = { collaborators, savedAt: new Date().toISOString() };
    localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(draft));
  } catch {
    // Storage quota exceeded or private browsing — fail silently.
  }
}

function clearDraft(): void {
  try {
    localStorage.removeItem(DRAFT_STORAGE_KEY);
  } catch {
    // ignore
  }
}

interface UseRoyaltyDraftReturn {
  /** Non-null when a saved draft is waiting for the user to accept or discard. */
  pendingDraft: RoyaltyDraft | null;
  /** Apply the pending draft and clear it from localStorage. */
  acceptDraft: () => void;
  /** Discard the pending draft and remove it from localStorage. */
  discardDraft: () => void;
  /** Clear any saved state for the current form. */
  clearSavedDraft: () => void;
  /** True while the debounced localStorage save is waiting to run. */
  saving: boolean;
  /** Last successful localStorage save time. */
  savedAt: string | null;
}

/**
 * Autosaves royalty configuration changes to localStorage and restores drafts
 * on return. Does not persist wallet secrets or signed payloads — only the
 * public address/percentage pairs that the contract's `initialize()` accepts.
 *
 * @param collaborators Current collaborator list from the form.
 * @param onRestore     Called with restored collaborators when user accepts a draft.
 */
export function useRoyaltyDraft(
  collaborators: DraftCollaborator[],
  onRestore: (collaborators: DraftCollaborator[]) => void,
): UseRoyaltyDraftReturn {
  const [pendingDraft, setPendingDraft] = useState<RoyaltyDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isFirstRender = useRef(true);

  // On mount: load any saved draft and offer it to the user.
  useEffect(() => {
    const draft = loadDraft();
    if (draft) {
      setPendingDraft(draft);
    }
  }, []);

  // Debounced autosave whenever collaborators change (skip the very first render
  // so we don't overwrite a draft before the user has a chance to restore it).
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }

    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);

    setSaving(true);
    saveTimerRef.current = setTimeout(() => {
      const hasContent = collaborators.some((c) => c.address || c.basisPoints);
      const isCompleteValidDraft = collaborators.every(
        (c) =>
          isValidStellarAccountAddress(c.address) &&
          c.basisPoints.trim().length > 0,
      );
      if (hasContent && isCompleteValidDraft) {
        saveDraft(collaborators);
        setSavedAt(new Date().toISOString());
      }
      setSaving(false);
    }, AUTOSAVE_DELAY_MS);

    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      setSaving(false);
    };
  }, [collaborators]);

  // Warn before the user navigates away while they have an in-progress form.
  useEffect(() => {
    function handleBeforeUnload(event: BeforeUnloadEvent) {
      const hasContent = collaborators.some((c) => c.address || c.basisPoints);
      if (hasContent) {
        event.preventDefault();
      }
    }

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [collaborators]);

  const acceptDraft = useCallback(() => {
    if (pendingDraft) {
      clearDraft();
      onRestore(pendingDraft.collaborators);
      setPendingDraft(null);
    }
  }, [pendingDraft, onRestore]);

  const discardDraft = useCallback(() => {
    clearDraft();
    setPendingDraft(null);
  }, []);

  const clearSavedDraft = useCallback(() => {
    clearDraft();
    setPendingDraft(null);
    setSavedAt(null);
    setSaving(false);
  }, []);

  return { pendingDraft, acceptDraft, discardDraft, clearSavedDraft, saving, savedAt };
}
