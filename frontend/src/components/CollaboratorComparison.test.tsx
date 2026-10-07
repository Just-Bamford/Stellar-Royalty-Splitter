/**
 * Tests for CollaboratorComparison (#923).
 */
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import CollaboratorComparison from "./CollaboratorComparison";
import type { CollaboratorSearchItem } from "../hooks/queries/useCollaboratorSearch";

function makeCollaborator(overrides: Partial<CollaboratorSearchItem>): CollaboratorSearchItem {
  return {
    address: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    basisPoints: 5000,
    sharePercentage: 50,
    tier: "regular",
    status: "active",
    totalEarned: 100,
    payoutCount: 1,
    joinDate: null,
    lastActivity: null,
    ...overrides,
  };
}

describe("CollaboratorComparison", () => {
  it("shows a message and no table when fewer than 2 collaborators are selected", () => {
    render(<CollaboratorComparison collaborators={[]} />);
    expect(screen.getByTestId("collaborator-comparison-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("collaborator-comparison")).not.toBeInTheDocument();
  });

  it("shows a message when only 1 collaborator is selected", () => {
    render(<CollaboratorComparison collaborators={[makeCollaborator({ address: "GA" })]} />);
    expect(screen.getByTestId("collaborator-comparison-empty")).toBeInTheDocument();
  });

  it("renders 2 collaborators side by side", () => {
    const collaborators = [
      makeCollaborator({ address: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", totalEarned: 500 }),
      makeCollaborator({ address: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", totalEarned: 300 }),
    ];
    render(<CollaboratorComparison collaborators={collaborators} />);

    const table = screen.getByTestId("collaborator-comparison");
    expect(table).toBeInTheDocument();
    // 2 data columns + 1 metric label column
    expect(screen.getAllByRole("columnheader")).toHaveLength(3);
    expect(screen.getByText("500")).toBeInTheDocument();
    expect(screen.getByText("300")).toBeInTheDocument();
  });

  it("renders up to 3 collaborators and shows an overflow notice beyond that", () => {
    const collaborators = [
      makeCollaborator({ address: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }),
      makeCollaborator({ address: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB" }),
      makeCollaborator({ address: "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC" }),
      makeCollaborator({ address: "GDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD" }),
    ];
    render(<CollaboratorComparison collaborators={collaborators} />);

    expect(screen.getAllByRole("columnheader")).toHaveLength(4); // metric + 3 collaborators
    expect(screen.getByText(/Comparing the first 3 of 4 selected/i)).toBeInTheDocument();
  });

  it("displays each metric row (share, earnings, payouts, tier, status)", () => {
    const collaborators = [
      makeCollaborator({ address: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", tier: "vip" }),
      makeCollaborator({ address: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", tier: "trial" }),
    ];
    render(<CollaboratorComparison collaborators={collaborators} />);

    expect(screen.getByText("Share")).toBeInTheDocument();
    expect(screen.getByText("Total Earned")).toBeInTheDocument();
    expect(screen.getByText("Payout Count")).toBeInTheDocument();
    expect(screen.getByText("Tier")).toBeInTheDocument();
    expect(screen.getByText("Status")).toBeInTheDocument();
    expect(screen.getByText("vip")).toBeInTheDocument();
    expect(screen.getByText("trial")).toBeInTheDocument();
  });
});
