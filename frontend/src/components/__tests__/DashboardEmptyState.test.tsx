import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom";
import { Dashboard } from "../Dashboard";
import * as SettingsContext from "../../context/SettingsContext";
import * as useAnalyticsHook from "../../hooks/queries/useAnalytics";
import * as useContractPerformanceHook from "../../hooks/queries/useContractPerformance";
import * as useChartDataHook from "../../hooks/useChartData";

vi.mock("../dashboard/index", () => ({
  DashboardHeader: () => null,
  MetricsGrid: () => null,
  EarningsChart: () => null,
  TopEarners: () => null,
  CollaboratorList: () => null,
}));

vi.mock("../BulkOperationsPanel", () => ({
  BulkOperationsPanel: () => null,
}));

vi.mock("../Charts", () => ({
  EarningsAreaChart: () => null,
  CollaboratorDonutChart: () => null,
  TimeSeriesChart: () => null,
  EarningsHeatmap: () => null,
  ChartCard: ({ children }: any) => <div>{children}</div>,
}));

describe("Dashboard Empty State", () => {
  it("renders 📊 icon and No Contract Selected message when contractId is empty (#1398)", () => {
    vi.spyOn(SettingsContext, "useSettings").mockReturnValue({
      settings: { currency: "USD", theme: "dark" } as any,
      updateSettings: vi.fn(),
      resetSettings: vi.fn(),
    });

    vi.spyOn(useAnalyticsHook, "useAnalytics").mockReturnValue({
      data: null,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    } as any);

    vi.spyOn(useContractPerformanceHook, "useContractPerformance").mockReturnValue({
      data: null,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    } as any);

    vi.spyOn(useChartDataHook, "useChartData").mockReturnValue({} as any);

    render(<Dashboard contractId="" />);

    expect(screen.getByText("No Contract Selected")).toBeInTheDocument();
    expect(screen.getByText("Please initialize or select a contract to view analytics.")).toBeInTheDocument();
    const emptyIcon = screen.getByText("📊");
    expect(emptyIcon).toBeInTheDocument();
    expect(emptyIcon).toHaveClass("empty-icon");
    expect(screen.queryByText("💏")).not.toBeInTheDocument();
  });
});
