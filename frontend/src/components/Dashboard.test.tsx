import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { Dashboard } from "./Dashboard";

vi.mock("../context/SettingsContext", () => ({
  useSettings: vi.fn(() => ({
    settings: { displayCurrency: "XLM", trackedContracts: [] },
    updateSettings: vi.fn(),
  })),
}));

vi.mock("../hooks/queries/useAnalytics", () => ({
  useAnalytics: vi.fn(() => ({
    data: { success: true, data: {} },
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  })),
}));

const mockContracts = [
  {
    contractId: "CONTRACT_1",
    name: "Contract Alpha",
    revenue: 1000,
    transactions: 50,
    lastActivity: "2026-11-20T10:00:00Z",
    status: "active",
  },
  {
    contractId: "CONTRACT_2",
    name: "Contract Beta",
    revenue: 2000,
    transactions: 80,
    lastActivity: "2026-11-21T12:00:00Z",
    status: "active",
  },
];

vi.mock("../hooks/queries/useContractPerformance", () => ({
  useContractPerformance: vi.fn(() => ({
    data: {
      success: true,
      data: {
        contracts: mockContracts,
      },
    },
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  })),
}));

vi.mock("../hooks/useChartData", () => ({
  useChartData: vi.fn(() => ({
    earningsSeries: [],
    collaboratorData: [],
    timeSeriesData: [],
    heatmapData: [],
  })),
}));

vi.mock("./dashboard/index", () => ({
  DashboardHeader: () => <div data-testid="dashboard-header" />,
  MetricsGrid: () => <div data-testid="metrics-grid" />,
  EarningsChart: () => <div data-testid="earnings-chart" />,
  TopEarners: () => <div data-testid="top-earners" />,
  CollaboratorList: () => <div data-testid="collaborator-list" />,
}));

vi.mock("./Charts", () => ({
  EarningsAreaChart: () => null,
  CollaboratorDonutChart: () => null,
  TimeSeriesChart: () => null,
  EarningsHeatmap: () => null,
  ChartCard: ({ children }: any) => <div>{children}</div>,
}));

vi.mock("./BulkOperationsPanel", () => ({
  BulkOperationsPanel: () => null,
}));

vi.mock("./Skeleton", () => ({
  DashboardSkeleton: () => null,
}));

describe("Dashboard - handleSelectAll logic (Issue #1429)", () => {
  it("renders table and toggles selection for all contracts accurately", () => {
    render(<Dashboard contractId="TEST_CONTRACT" />);

    const selectAllCheckbox = screen.getByLabelText("Select all contracts") as HTMLInputElement;
    expect(selectAllCheckbox.checked).toBe(false);

    // Click Select All -> all contracts become selected
    fireEvent.click(selectAllCheckbox);
    expect(selectAllCheckbox.checked).toBe(true);

    const contract1Checkbox = screen.getByLabelText("Select contract CONTRACT_1") as HTMLInputElement;
    const contract2Checkbox = screen.getByLabelText("Select contract CONTRACT_2") as HTMLInputElement;
    expect(contract1Checkbox.checked).toBe(true);
    expect(contract2Checkbox.checked).toBe(true);

    // Uncheck one contract -> select all is no longer checked
    fireEvent.click(contract1Checkbox);
    expect(selectAllCheckbox.checked).toBe(false);

    // Click Select All again -> all contracts become selected
    fireEvent.click(selectAllCheckbox);
    expect(selectAllCheckbox.checked).toBe(true);
    expect(contract1Checkbox.checked).toBe(true);
    expect(contract2Checkbox.checked).toBe(true);

    // Click Select All when all selected -> unselects all
    fireEvent.click(selectAllCheckbox);
    expect(selectAllCheckbox.checked).toBe(false);
    expect(contract1Checkbox.checked).toBe(false);
    expect(contract2Checkbox.checked).toBe(false);
  });

  it("handles edge case where selected count equals contracts count but sets do not match", () => {
    // If user has 1 contract selected out of 2, selectAllCheckbox should not be checked
    render(<Dashboard contractId="TEST_CONTRACT" />);
    const selectAllCheckbox = screen.getByLabelText("Select all contracts") as HTMLInputElement;
    const contract1Checkbox = screen.getByLabelText("Select contract CONTRACT_1") as HTMLInputElement;
    const contract2Checkbox = screen.getByLabelText("Select contract CONTRACT_2") as HTMLInputElement;

    // Select contract 1
    fireEvent.click(contract1Checkbox);
    expect(contract1Checkbox.checked).toBe(true);
    expect(contract2Checkbox.checked).toBe(false);
    expect(selectAllCheckbox.checked).toBe(false);

    // Clicking select all selects both
    fireEvent.click(selectAllCheckbox);
    expect(selectAllCheckbox.checked).toBe(true);
    expect(contract1Checkbox.checked).toBe(true);
    expect(contract2Checkbox.checked).toBe(true);
  });
});
