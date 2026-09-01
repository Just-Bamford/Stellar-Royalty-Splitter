import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DuplicateConfigBanner } from "../DuplicateConfigBanner";
import type { RoyaltyConfigDraft } from "../../utils/configDuplication";

describe("DuplicateConfigBanner", () => {
  let mockDraft: RoyaltyConfigDraft;

  beforeEach(() => {
    mockDraft = {
      sourceContractId: "CCONTRACT123456789",
      sourceCreatedAt: new Date().toISOString(),
      isDuplicate: true,
      duplicatedAt: new Date().toISOString(),
      collaborators: [
        { address: "GABC", basisPoints: "50" },
        { address: "GDEF", basisPoints: "50" },
      ],
    };

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-15T10:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should render banner when isDuplicate is true", () => {
    const onClear = vi.fn();

    render(
      <DuplicateConfigBanner draft={mockDraft} onClearDuplicate={onClear} />,
    );

    expect(screen.getByText(/Editing a duplicate/)).toBeInTheDocument();
  });

  it("should not render when isDuplicate is false", () => {
    mockDraft.isDuplicate = false;
    const onClear = vi.fn();

    const { container } = render(
      <DuplicateConfigBanner draft={mockDraft} onClearDuplicate={onClear} />,
    );

    expect(container.firstChild).toBeNull();
  });

  it("should display collaborator count", () => {
    const onClear = vi.fn();

    render(
      <DuplicateConfigBanner draft={mockDraft} onClearDuplicate={onClear} />,
    );

    expect(screen.getByText(/2 collaborators/)).toBeInTheDocument();
  });

  it("should show singular for single collaborator", () => {
    mockDraft.collaborators = [{ address: "GABC", basisPoints: "100" }];
    const onClear = vi.fn();

    render(
      <DuplicateConfigBanner draft={mockDraft} onClearDuplicate={onClear} />,
    );

    expect(screen.getByText(/1 collaborator/)).toBeInTheDocument();
  });

  it("should display time ago", () => {
    const onClear = vi.fn();

    render(
      <DuplicateConfigBanner draft={mockDraft} onClearDuplicate={onClear} />,
    );

    expect(screen.getByText(/Duplicated/)).toBeInTheDocument();
  });

  it("should call onClearDuplicate when clear button is clicked", () => {
    const onClear = vi.fn();

    render(
      <DuplicateConfigBanner draft={mockDraft} onClearDuplicate={onClear} />,
    );

    const clearButton = screen.getByRole("button", { name: /Clear duplicate/ });
    fireEvent.click(clearButton);

    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("should have accessible clear button", () => {
    const onClear = vi.fn();

    render(
      <DuplicateConfigBanner draft={mockDraft} onClearDuplicate={onClear} />,
    );

    const clearButton = screen.getByRole("button");
    expect(clearButton).toHaveAttribute("aria-label");
    expect(clearButton).toHaveAttribute("title");
  });

  it("should have proper status role for screen readers", () => {
    const onClear = vi.fn();

    const { container } = render(
      <DuplicateConfigBanner draft={mockDraft} onClearDuplicate={onClear} />,
    );

    const banner = container.querySelector('[role="status"]');
    expect(banner).toHaveAttribute("aria-live", "polite");
  });

  it("should abbreviate contract ID", () => {
    mockDraft.sourceContractId = "CORIGINALCONTRACT123456789";
    const onClear = vi.fn();

    render(
      <DuplicateConfigBanner draft={mockDraft} onClearDuplicate={onClear} />,
    );

    expect(screen.getByText(/CORIGIN\.\.\./)).toBeInTheDocument();
  });

  it("should show time ago correctly", () => {
    mockDraft.duplicatedAt = new Date("2024-01-15T09:00:00Z").toISOString();
    const onClear = vi.fn();

    render(
      <DuplicateConfigBanner draft={mockDraft} onClearDuplicate={onClear} />,
    );

    // 1 hour ago
    expect(screen.getByText(/1h ago/)).toBeInTheDocument();
  });

  it("should include draft disclaimer", () => {
    const onClear = vi.fn();

    render(
      <DuplicateConfigBanner draft={mockDraft} onClearDuplicate={onClear} />,
    );

    expect(
      screen.getByText(/draft.*won't affect the original/),
    ).toBeInTheDocument();
  });

  it("should be dismissable", () => {
    const onClear = vi.fn();

    render(
      <DuplicateConfigBanner draft={mockDraft} onClearDuplicate={onClear} />,
    );

    const clearBtn = screen.getByRole("button");
    expect(clearBtn.textContent).toContain("✕");
  });

  afterEach(() => {
    vi.useRealTimers();
  });
});
