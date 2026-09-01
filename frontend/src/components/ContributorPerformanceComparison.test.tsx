import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import "@testing-library/jest-dom";
import ContributorPerformanceComparison, { buildPerformanceRows } from "./ContributorPerformanceComparison";
import type { CollaboratorEarning } from "./EarningsDashboard";

const NOW = Date.parse("2026-08-29T12:00:00.000Z");
const collaborators: CollaboratorEarning[] = [
  {
    address: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    basisPoints: 6000,
    totalEarned: 600,
    payoutCount: 6,
    avgPayout: 100,
    firstActivity: "2026-07-30T12:00:00.000Z",
    lastActivity: "2026-08-28T12:00:00.000Z",
  },
  {
    address: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    basisPoints: 4000,
    totalEarned: 400,
    payoutCount: 2,
    avgPayout: 200,
    firstActivity: "2026-05-01T12:00:00.000Z",
    lastActivity: "2026-07-01T12:00:00.000Z",
  },
];

describe("ContributorPerformanceComparison", () => {
  it("calculates frequency and marks contributors inactive after 30 days", () => {
    const rows = buildPerformanceRows(collaborators, NOW);
    expect(rows[0].frequency).toBeGreaterThan(rows[1].frequency);
    expect(rows[0].inactive).toBe(false);
    expect(rows[1].inactive).toBe(true);
  });

  it("renders summary metrics and changes ordering when sort changes", () => {
    render(<ContributorPerformanceComparison collaborators={collaborators} currency="XLM" />);
    expect(screen.getByTestId("top-earner")).toHaveTextContent("GAAAAAAA");
    expect(screen.getByTestId("inactive-count")).toHaveTextContent("1");

    fireEvent.change(screen.getByLabelText("Sort contributors by"), {
      target: { value: "payoutCount" },
    });
    const rows = screen.getAllByRole("row");
    expect(rows[1]).toHaveTextContent("GAAAAAAAAA");
  });
});
