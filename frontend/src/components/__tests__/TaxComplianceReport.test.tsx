import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "@testing-library/jest-dom";
import { TaxComplianceReport } from "../TaxComplianceReport";
import { api } from "../../api";

vi.mock("../../api", () => ({
  api: {
    getTaxComplianceReport: vi.fn(),
    getContributorsMissingTaxInfo: vi.fn(),
  },
}));

describe("TaxComplianceReport Component (#1342)", () => {
  const mockCompliance = {
    data: [
      { id: "1", contributorAddress: "GABC123", status: "compliant" },
    ],
    summary: { total: 10, compliant: 8, nonCompliant: 1, missing: 1 },
  };

  const mockMissing = {
    data: [
      { id: "2", contributorAddress: "GDEF456" },
    ],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getTaxComplianceReport).mockResolvedValue(mockCompliance as any);
    vi.mocked(api.getContributorsMissingTaxInfo).mockResolvedValue(mockMissing as any);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("loads and renders tax compliance reports on mount", async () => {
    render(<TaxComplianceReport />);

    expect(screen.getByText("Loading compliance report...")).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText("Tax Compliance Report")).toBeInTheDocument();
      expect(screen.getByText("Total Contributors")).toBeInTheDocument();
      expect(screen.getByText("10")).toBeInTheDocument();
      expect(screen.getByText("8")).toBeInTheDocument();
    });

    expect(api.getTaxComplianceReport).toHaveBeenCalledTimes(1);
    expect(api.getContributorsMissingTaxInfo).toHaveBeenCalledTimes(1);
  });

  it("auto-refreshes compliance report via 60-second polling interval", async () => {
    vi.useFakeTimers();

    render(<TaxComplianceReport />);

    // Initial mount call
    expect(api.getTaxComplianceReport).toHaveBeenCalledTimes(1);

    // Advance 60 seconds
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.getTaxComplianceReport).toHaveBeenCalledTimes(2);

    // Advance another 60 seconds
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.getTaxComplianceReport).toHaveBeenCalledTimes(3);
  });

  it("cleans up the 60-second polling interval on unmount", async () => {
    vi.useFakeTimers();
    const clearIntervalSpy = vi.spyOn(global, "clearInterval");

    const { unmount } = render(<TaxComplianceReport />);
    await vi.runOnlyPendingTimersAsync();

    unmount();

    expect(clearIntervalSpy).toHaveBeenCalled();
  });

  it("refreshes reports manually when refresh button is clicked", async () => {
    render(<TaxComplianceReport />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Refresh" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    await waitFor(() => {
      expect(api.getTaxComplianceReport).toHaveBeenCalledTimes(2);
    });
  });
});
