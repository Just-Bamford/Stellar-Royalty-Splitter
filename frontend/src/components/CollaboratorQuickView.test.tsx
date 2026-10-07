/**
 * Tests for CollaboratorQuickView (#923).
 */
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import CollaboratorQuickView from "./CollaboratorQuickView";
import type { CollaboratorSearchItem } from "../hooks/queries/useCollaboratorSearch";

const COLLAB: CollaboratorSearchItem = {
  address: "GALAXY1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZAAAA",
  basisPoints: 6500,
  sharePercentage: 65,
  name: "Alice",
  tier: "vip",
  status: "active",
  totalEarned: 1234,
  payoutCount: 7,
  joinDate: "2024-01-15T00:00:00.000Z",
  lastActivity: "2024-06-20T00:00:00.000Z",
};

describe("CollaboratorQuickView", () => {
  it("renders nothing (modal closed) when collaborator is null", () => {
    render(<CollaboratorQuickView collaborator={null} onClose={() => {}} />);
    expect(screen.queryByTestId("collaborator-quick-view")).not.toBeInTheDocument();
  });

  it("renders full profile data when a collaborator is provided", () => {
    render(<CollaboratorQuickView collaborator={COLLAB} onClose={() => {}} />);

    expect(screen.getByTestId("collaborator-quick-view")).toBeInTheDocument();
    expect(screen.getByText(COLLAB.address)).toBeInTheDocument();
    expect(screen.getByText("65.00%")).toBeInTheDocument();
    expect(screen.getByText("1,234")).toBeInTheDocument();
    expect(screen.getByText("7")).toBeInTheDocument();
    expect(screen.getByText(/VIP/)).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
  });

  it("shows a dash for missing join date / last activity", () => {
    render(
      <CollaboratorQuickView
        collaborator={{ ...COLLAB, joinDate: null, lastActivity: null }}
        onClose={() => {}}
      />,
    );
    const dashes = screen.getAllByText("—");
    expect(dashes.length).toBe(2);
  });

  it("calls onClose when the modal close button is clicked", () => {
    const onClose = vi.fn();
    const { container } = render(
      <CollaboratorQuickView collaborator={COLLAB} onClose={onClose} />,
    );
    const closeBtn = container.querySelector(".a11y-modal-close");
    expect(closeBtn).toBeTruthy();
    fireEvent.click(closeBtn!);
    expect(onClose).toHaveBeenCalled();
  });
});
