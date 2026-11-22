import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom";
import { Dashboard } from "../Dashboard";
import * as SettingsContext from "../../context/SettingsContext";
import * as useAnalyticsHook from "../../hooks/queries/useAnalytics";
import * as useContractPerformanceHook from "../../hooks/queries/useContractPerformance";
import * as useChartDataHook from "../../hooks/useChartData";

vi.mock("../dashboard/index", () => ({
  DashboardHeader: () => <div data-testid="dashboard-header" />,
  MetricsGrid: () => <div data-testid="metrics-grid" />,
  EarningsChart: () => <div data-testid="earnings-chart" />,
  TopEarners: () => <div data-testid="top-earners" />,
  CollaboratorList: () => <div data-testid="collaborator-list" />,
}));

vi.mock("../BulkOperationsPanel", () => ({
  BulkOperationsPanel: () => <div data-testid="bulk-ops" />,
}));

vi.mock("../Charts", () => ({
  EarningsAreaChart: () => null,
  CollaboratorDonutChart: () => null,
  TimeSeriesChart: () => null,
  EarningsHeatmap: () => null,
  ChartCard: ({ children }: any) => <div>{children}</div>,
}));

describe("Dashboard handleSelectContract", () => {
  const mockContracts = [
    {
      contractId: "CA111111111111111111111111111111111111111111111111111111111111",
      revenue: 1000,
      transactions: 10,
      collaborators: 2,
    },
    {
      contractId: "CB222222222222222222222222222222222222222222222222222222222222",
      revenue: 500,
      transactions: 5,
      collaborators: 1,
    },
  ];

  beforeEach(() => {
    vi.spyOn(SettingsContext, "useSettings").mockReturnValue({
      settings: { currency: "USD", theme: "dark" } as any,
      updateSettings: vi.fn(),
      resetSettings: vi.fn(),
    });

    vi.spyOn(useAnalyticsHook, "useAnalytics").mockReturnValue({
      data: { totalRevenue: 1500, activeContracts: 2 } as any,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    } as any);

    vi.spyOn(useContractPerformanceHook, "useContractPerformance").mockReturnValue({
      data: {
        success: true,
        data: {
          contracts: mockContracts,
          totalRevenue: 1500,
          totalTransactions: 15,
        },
      } as any,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    } as any);

    vi.spyOn(useChartDataHook, "useChartData").mockReturnValue({} as any);
  });

  it("selects unselected contract on normal click and deselects on second normal click", () => {
    render(<Dashboard contractId="CA111111111111111111111111111111111111111111111111111111111111" />);

    const checkboxes = screen.getAllByRole("checkbox");
    const contractCheckbox = checkboxes[1]; // first contract checkbox (index 0 is select all)

    expect(contractCheckbox).not.toBeChecked();

    fireEvent.click(contractCheckbox);
    expect(contractCheckbox).toBeChecked();

    fireEvent.click(contractCheckbox);
    expect(contractCheckbox).not.toBeChecked();
  });

  it("selects unselected contract on shift-click and deselects on second shift-click (#1399)", () => {
    render(<Dashboard contractId="CA111111111111111111111111111111111111111111111111111111111111" />);

    const checkboxes = screen.getAllByRole("checkbox");
    const contractCheckbox = checkboxes[1];

    expect(contractCheckbox).not.toBeChecked();

    // Shift-click selects
    fireEvent.click(contractCheckbox, { shiftKey: true });
    expect(contractCheckbox).toBeChecked();

    // Shift-click again deselects
    fireEvent.click(contractCheckbox, { shiftKey: true });
    expect(contractCheckbox).not.toBeChecked();
  });
});
