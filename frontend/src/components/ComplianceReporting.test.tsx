import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComplianceReporting } from "./ComplianceReporting";

describe("ComplianceReporting", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("shows an inline error before requesting a report with a malformed address", async () => {
    const fetchReport = vi.fn().mockResolvedValue({
      json: async () => ({ success: true, data: { reportId: 42 } }),
    });
    vi.stubGlobal("fetch", fetchReport);

    render(<ComplianceReporting />);
    fireEvent.click(screen.getByRole("button", { name: "Form 8949 (IRS)" }));
    const wallet = screen.getByLabelText("Wallet Address (G...)");
    const generate = screen.getByRole("button", { name: "Generate Report" });

    fireEvent.change(wallet, { target: { value: "G123" } });
    fireEvent.click(generate);
    expect(screen.getByRole("alert")).toHaveTextContent("Invalid Stellar address");
    expect(fetchReport).not.toHaveBeenCalled();

    const address = "G" + "A".repeat(55);
    fireEvent.change(wallet, { target: { value: address } });
    fireEvent.click(generate);
    expect(await screen.findByText("Result")).toBeInTheDocument();
    expect(fetchReport).toHaveBeenCalledWith(
      expect.stringContaining("walletAddress=" + address),
      expect.anything(),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("omits the optional wallet filter when generating a CSV report", async () => {
    const fetchReport = vi.fn().mockResolvedValue({
      json: async () => ({ success: true, data: { reportId: 42 } }),
    });
    vi.stubGlobal("fetch", fetchReport);

    render(<ComplianceReporting />);
    fireEvent.click(screen.getByRole("button", { name: "Generate Report" }));

    expect(await screen.findByText("Result")).toBeInTheDocument();
    expect(fetchReport).toHaveBeenCalledTimes(1);
    const url = new URL(fetchReport.mock.calls[0][0]);
    expect(url.pathname).toBe("/api/v1/compliance/csv-export");
    expect(url.searchParams.has("walletAddress")).toBe(false);
  });
});
