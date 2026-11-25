import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom";

// #1398: the "No Contract Selected" empty state shows a chart icon, not 💏.

vi.mock("../context/SettingsContext", () => ({
  useSettings: () => ({ settings: {} }),
}));
vi.mock("../hooks/queries/useAnalytics", () => ({
  useAnalytics: () => ({ data: undefined, isLoading: false, error: null }),
}));
vi.mock("../hooks/queries/useContractPerformance", () => ({
  useContractPerformance: () => ({ data: undefined, isLoading: false, error: null }),
}));
vi.mock("../hooks/useChartData", () => ({
  useChartData: () => ({}),
}));

import { Dashboard } from "./Dashboard";

describe("Dashboard empty state (#1398)", () => {
  it("uses a relevant icon when no contract is selected", () => {
    const { container } = render(<Dashboard contractId="" />);

    expect(screen.getByRole("heading", { name: "No Contract Selected" })).toBeInTheDocument();
    const icon = container.querySelector(".empty-icon");
    expect(icon).toHaveTextContent("📊");
    expect(icon).toHaveAttribute("aria-hidden", "true");
    expect(container).not.toHaveTextContent("💏");
  });
});
