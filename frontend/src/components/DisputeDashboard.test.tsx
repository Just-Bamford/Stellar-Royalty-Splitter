import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { DisputeDashboard } from "./DisputeDashboard";

describe("DisputeDashboard", () => {
  it("renders the dashboard KPIs and dispute groups", () => {
    render(<DisputeDashboard />);

    expect(screen.getByText("Dispute dashboard")).toBeInTheDocument();
    expect(screen.getByText("Open disputes")).toBeInTheDocument();
    expect(screen.getByText("Avg. resolution")).toBeInTheDocument();
    expect(screen.getAllByText("Clawed back").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Open").length).toBeGreaterThan(0);
  });

  it("opens a dispute detail panel and lets an admin resolve it", () => {
    render(<DisputeDashboard />);

    fireEvent.click(screen.getByText("Payout mismatch for September cycle"));

    expect(screen.getByText("Admin response")).toBeInTheDocument();
    const resolveButton = screen.getByRole("button", { name: "Resolve" });
    expect(resolveButton).toBeInTheDocument();

    fireEvent.click(resolveButton);

    expect(screen.queryByRole("button", { name: "Resolve" })).not.toBeInTheDocument();
  });
});
