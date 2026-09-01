/**
 * Tests for the keyboard shortcuts hook + matcher (#518).
 */

import { describe, test, expect } from "vitest";
import {
  formatShortcut,
  matchesShortcut,
  type Shortcut,
} from "./useKeyboardShortcuts";

function evt(
  init: Partial<KeyboardEventInit & { key: string }>,
): KeyboardEvent {
  return new KeyboardEvent("keydown", init as KeyboardEventInit);
}

describe("matchesShortcut (#518)", () => {
  const submit: Shortcut = {
    id: "submit",
    key: "Enter",
    ctrl: true,
    description: "Submit",
    handler: () => undefined,
  };
  const search: Shortcut = {
    id: "search",
    key: "k",
    ctrl: true,
    description: "Search",
    handler: () => undefined,
  };
  const save: Shortcut = {
    id: "save",
    key: "s",
    ctrl: true,
    description: "Save",
    handler: () => undefined,
  };

  test("matches the configured key + primary modifier", () => {
    expect(matchesShortcut(evt({ key: "Enter", ctrlKey: true }), submit)).toBe(
      true,
    );
    expect(matchesShortcut(evt({ key: "k", ctrlKey: true }), search)).toBe(
      true,
    );
    expect(matchesShortcut(evt({ key: "s", ctrlKey: true }), save)).toBe(true);
  });

  test("rejects when the primary modifier is missing", () => {
    expect(matchesShortcut(evt({ key: "Enter" }), submit)).toBe(false);
    expect(matchesShortcut(evt({ key: "s" }), save)).toBe(false);
  });

  test("rejects when an extra modifier is held that the shortcut does not require", () => {
    expect(
      matchesShortcut(evt({ key: "k", ctrlKey: true, shiftKey: true }), search),
    ).toBe(false);
    expect(
      matchesShortcut(evt({ key: "s", ctrlKey: true, altKey: true }), save),
    ).toBe(false);
  });

  test("formatShortcut produces a human-readable label", () => {
    // Cannot assume mac vs non-mac in CI; just assert structural pieces.
    const label = formatShortcut(submit);
    expect(label.endsWith("Enter")).toBe(true);
    expect(label.includes("+")).toBe(true);
  });
});
