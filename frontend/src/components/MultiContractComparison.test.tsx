import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { vi, type Mock } from "vitest";
import "@testing-library/jest-dom/vitest";
import {
  MultiContractComparison,
  aggregateTotals,
} from "./MultiContractComparison";

vi.mock("../api", () => ({
  api: {
    getAnalytics: vi.fn(),
  },
}));

import { api } from "../api";

vi.mock("../context/SettingsContext", () => ({
  useSettings: () => ({
    settings: { displayCurrency: "XLM" },
    updateSettings: vi.fn(),
  }),
}));

const mockGetAnalytics = api.getAnalytics as Mock;

const CONTRACT_A = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const CONTRACT_B = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

function analyticsFor(total: number, primary: number, secondary: number) {
  return {
    success: true,
    data: {
      totalDistributed: total,
      primaryRoyaltiesTotal: primary,
      secondaryRoyaltiesTotal: secondary,
      collaboratorStats: [{ address: "GABC", totalEarned: total, payoutCount: 2 }],
    },
  };
}

describe("MultiContractComparison", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders empty state when no contracts are tracked", () => {
    render(<MultiContractComparison contractIds={[]} />);
    expect(screen.getByTestId("comparison-empty")).toBeInTheDocument();
    expect(mockGetAnalytics).not.toHaveBeenCalled();
  });

  it("shows loading state while fetching", () => {
    mockGetAnalytics.mockReturnValue(new Promise(() => {}));
    render(<MultiContractComparison contractIds={[CONTRACT_A]} />);
    expect(screen.getByTestId("comparison-loading")).toBeInTheDocument();
  });

  it("fetches earnings for all contracts in parallel and shows a total row", async () => {
    mockGetAnalytics.mockImplementation((id: string) =>
      id === CONTRACT_A
        ? Promise.resolve(analyticsFor(1000, 700, 300))
        : Promise.resolve(analyticsFor(500, 400, 100)),
    );

    render(
      <MultiContractComparison contractIds={[CONTRACT_A, CONTRACT_B]} />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("comparison-table")).toBeInTheDocument();
    });

    // Both contracts were queried
    expect(mockGetAnalytics).toHaveBeenCalledTimes(2);
    expect(mockGetAnalytics).toHaveBeenCalledWith(CONTRACT_A);
    expect(mockGetAnalytics).toHaveBeenCalledWith(CONTRACT_B);

    // Aggregated totals across all contracts
    expect(screen.getByTestId("total-all-distributed")).toHaveTextContent(
      "1,500",
    );
    expect(screen.getByTestId("total-all-primary")).toHaveTextContent("1,100");
    expect(screen.getByTestId("total-all-secondary")).toHaveTextContent("400");

    // Total row appears once
    expect(screen.getAllByText(/Total \(/)).toHaveLength(1);
  });

  it("marks unreachable contracts as errors without failing the view", async () => {
    mockGetAnalytics.mockImplementation((id: string) =>
      id === CONTRACT_A
        ? Promise.resolve(analyticsFor(1000, 700, 300))
        : Promise.reject(new Error("RPC timeout")),
    );

    render(
      <MultiContractComparison contractIds={[CONTRACT_A, CONTRACT_B]} />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("comparison-table")).toBeInTheDocument();
    });

    // Partial failure warning is shown
    expect(screen.getByTestId("comparison-partial-error")).toBeInTheDocument();

    // Failed contract marked Unreachable
    expect(
      screen.getByTestId(`contract-error-${CONTRACT_B}`),
    ).toHaveTextContent("Unreachable");

    // Totals only include reachable contracts
    expect(screen.getByTestId("total-all-distributed")).toHaveTextContent(
      "1,000",
    );
  });

  it("refreshes data when the refresh button is clicked", async () => {
    mockGetAnalytics.mockResolvedValue(analyticsFor(100, 60, 40));

    render(<MultiContractComparison contractIds={[CONTRACT_A]} />);

    await waitFor(() => {
      expect(screen.getByTestId("comparison-table")).toBeInTheDocument();
    });
    expect(mockGetAnalytics).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: /Refresh/i }));
    await waitFor(() => {
      expect(mockGetAnalytics).toHaveBeenCalledTimes(2);
    });
  });
});

describe("aggregateTotals", () => {
  it("sums only successfully loaded rows", () => {
    const rows = [
      {
        contractId: CONTRACT_A,
        status: "loaded" as const,
        totalDistributed: 100,
        primaryTotal: 70,
        secondaryTotal: 30,
        collaboratorCount: 2,
      },
      {
        contractId: CONTRACT_B,
        status: "error" as const,
        totalDistributed: 999,
        primaryTotal: 999,
        secondaryTotal: 999,
        collaboratorCount: 0,
        errorMessage: "down",
      },
    ];

    expect(aggregateTotals(rows)).toEqual({
      totalDistributed: 100,
      primaryTotal: 70,
      secondaryTotal: 30,
    });
  });
});
