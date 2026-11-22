import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom";
import { ComplianceReporting } from "../ComplianceReporting";

describe("ComplianceReporting Wallet Address Validation (#1376)", () => {
  const validAddress = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const invalidAddress = "GNOTVALID";

  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn().mockImplementation(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true, rows: [] }),
      })
    );
  });

  it("shows error banner and does not call API when wallet address is non-empty and invalid", async () => {
    render(<ComplianceReporting />);

    // Switch to Form 8949 which renders wallet address input
    const form8949Btn = screen.getByRole("button", { name: /Form 8949/i });
    fireEvent.click(form8949Btn);

    const input = screen.getByPlaceholderText("GABC123...");
    fireEvent.change(input, { target: { value: invalidAddress } });

    const generateBtn = screen.getByRole("button", { name: "Generate Report" });
    fireEvent.click(generateBtn);

    expect(
      screen.getByText("Please enter a valid Stellar address (starts with G, 56 characters)")
    ).toBeInTheDocument();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("permits generation when wallet address is empty for reports that do not require it", async () => {
    render(<ComplianceReporting />);

    // Default report type is CSV which does not require wallet address
    const generateBtn = screen.getByRole("button", { name: "Generate Report" });
    fireEvent.click(generateBtn);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalled();
    });
    expect(
      screen.queryByText("Please enter a valid Stellar address (starts with G, 56 characters)")
    ).not.toBeInTheDocument();
  });

  it("proceeds with API fetch when wallet address is a valid 56-character G-address", async () => {
    render(<ComplianceReporting />);

    const form8949Btn = screen.getByRole("button", { name: /Form 8949/i });
    fireEvent.click(form8949Btn);

    const input = screen.getByPlaceholderText("GABC123...");
    fireEvent.change(input, { target: { value: validAddress } });

    const generateBtn = screen.getByRole("button", { name: "Generate Report" });
    fireEvent.click(generateBtn);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalled();
    });
    expect(
      screen.queryByText("Please enter a valid Stellar address (starts with G, 56 characters)")
    ).not.toBeInTheDocument();
  });
});
