import { useEffect } from "react";
import { analytics } from "../lib/analytics";

/**
 * Frontend keyboard shortcuts for power users (#518).
 *
 * Design notes:
 * - A single `useKeyboardShortcuts(shortcuts)` hook registers a window-
 *   level keydown listener that matches against the provided combos and
 *   invokes the handler. This means each call site declares only the
 *   shortcuts it cares about, and the listener auto-disconnects on
 *   unmount.
 * - Combos are described as plain `Shortcut` objects rather than strings
 *   so TypeScript catches typos at the call site.
 * - Inputs/textareas/contenteditable elements are skipped by default —
 *   Ctrl+S in a text field should NOT trigger our save shortcut, it
 *   should let the browser do whatever its default is.
 * - Every shortcut invocation dispatches an `analytics.shortcut_used`
 *   event so we can measure adoption (#524 integration).
 */

export interface Shortcut {
  /** A short, unique id used for the analytics event and the help modal row. */
  id: string;
  key: string;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
  /** Cross-platform: matches Cmd on Mac OR Ctrl elsewhere. Defaults to false. */
  meta?: boolean;
  /** Whether the shortcut fires while focus is in an input. Defaults to false. */
  allowInInput?: boolean;
  /** Human-readable label rendered in the help modal and tooltips. */
  description: string;
  /** Handler invoked when the combo matches. Receives the original KeyboardEvent. */
  handler: (e: KeyboardEvent) => void;
}

const INPUT_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) return false;
  if (INPUT_TAGS.has(target.tagName)) return true;
  if (target.isContentEditable) return true;
  return false;
}

/** Detect macOS so Ctrl/Cmd can be treated as equivalent for cross-platform combos. */
function isMac(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPod|iPhone|iPad/.test(navigator.platform);
}

export function matchesShortcut(e: KeyboardEvent, s: Shortcut): boolean {
  if (e.key.toLowerCase() !== s.key.toLowerCase()) return false;
  // Treat ctrl/meta as a single "primary modifier" for cross-platform combos.
  const primary = isMac() ? e.metaKey : e.ctrlKey;
  const wantPrimary = !!(s.ctrl || s.meta);
  if (wantPrimary !== primary) return false;
  if (!!s.alt !== e.altKey) return false;
  if (!!s.shift !== e.shiftKey) return false;
  return true;
}

/**
 * Register the supplied shortcuts on the window keydown listener for the
 * lifetime of the calling component.
 */
export function useKeyboardShortcuts(shortcuts: Shortcut[]): void {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      for (const s of shortcuts) {
        if (!matchesShortcut(e, s)) continue;
        if (!s.allowInInput && isEditableTarget(e.target)) continue;
        e.preventDefault();
        analytics.dispatch("shortcut_used", { combo: s.id });
        try {
          s.handler(e);
        } catch {
          // Handler failures must never break the window listener.
        }
        return;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [shortcuts]);
}

/**
 * Format a shortcut for display in tooltips / help modal (e.g. "Ctrl+Enter").
 * On Mac the primary modifier is rendered as ⌘ to match platform conventions.
 */
export function formatShortcut(s: Shortcut): string {
  const parts: string[] = [];
  if (s.ctrl || s.meta) parts.push(isMac() ? "⌘" : "Ctrl");
  if (s.alt) parts.push(isMac() ? "⌥" : "Alt");
  if (s.shift) parts.push(isMac() ? "⇧" : "Shift");
  parts.push(s.key.length === 1 ? s.key.toUpperCase() : s.key);
  return parts.join("+");
}
