import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom";
import { AdvancedAnalyticsDashboard } from "../AdvancedAnalyticsDashboard";
import type { PayoutRecord } from "../../lib/advanced-analytics";

vi.mock("../../context/SettingsContext", () => ({
  useSettings: vi.fn(() => ({
    settings: { displayCurrency: "XLM" },
    updateSettings: vi.fn(),
  })),
}));

// Mock recharts ResponsiveContainer to render children cleanly in test env
vi.mock("recharts", async () => {
  const actual = await vi.importActual<typeof import("recharts")>("recharts");
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="responsive-container">{children}</div>
    ),
  };
});

const mockPayouts: PayoutRecord[] = [
  { timestamp: "2026-08-01T10:00:00Z", amount: 100 },
  { timestamp: "2026-08-02T11:00:00Z", amount: 110 },
  { timestamp: "2026-08-03T12:00:00Z", amount: 95 },
  { timestamp: "2026-08-04T13:00:00Z", amount: 105 },
  { timestamp: "2026-08-05T14:00:00Z", amount: 20 }, // Severe drop -> Red heatmap cell
  { timestamp: "2026-08-06T15:00:00Z", amount: 600 }, // Spike -> Outlier anomaly
];

describe("AdvancedAnalyticsDashboard Component", () => {
  it("renders header and control toggles", () => {
    render(<AdvancedAnalyticsDashboard payouts={mockPayouts} />);
    expect(screen.getByText("📊 Advanced Analytics Dashboard")).toBeInTheDocument();
    expect(screen.getByLabelText(/7-Day MA/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Forecast Band/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Anomalies/i)).toBeInTheDocument();
  });

  it("renders heatmap cells with status color coding", () => {
    render(<AdvancedAnalyticsDashboard payouts={mockPayouts} />);
    expect(screen.getByTestId("analytics-heatmap-grid")).toBeInTheDocument();
    expect(screen.getByTestId("heatmap-cell-2026-08-05")).toHaveClass("status-red");
  });

  it("renders anomaly outlier section when anomalies are present", () => {
    render(<AdvancedAnalyticsDashboard payouts={mockPayouts} />);
    expect(screen.getByTestId("analytics-anomalies-section")).toBeInTheDocument();
    expect(screen.getByText(/Detected Anomalies & Outliers/i)).toBeInTheDocument();
  });

  it("triggers drill-down view when a heatmap cell is clicked and allows navigation back", () => {
    render(<AdvancedAnalyticsDashboard payouts={mockPayouts} />);

    const cell = screen.getByTestId("heatmap-cell-2026-08-01");
    fireEvent.click(cell);

    expect(screen.getByTestId("analytics-drilldown-view")).toBeInTheDocument();
    expect(screen.getByText(/Drill-Down Detail: 2026-08-01/i)).toBeInTheDocument();

    const backBtn = screen.getByTestId("drilldown-back-btn");
    fireEvent.click(backBtn);

    expect(screen.queryByTestId("analytics-drilldown-view")).not.toBeInTheDocument();
  });
});
