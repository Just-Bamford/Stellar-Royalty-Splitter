import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, beforeEach, test, expect, vi } from "vitest";
import { ContributorTaxInfo } from "../ContributorTaxInfo";
import { api } from "../../api";

vi.mock("../../api");

const mockApi = api as any;
const WALLET = "GA7E6YDRQKJ2JNOG27UPSCQ3FQ6U4X3QQGJKHNGF23T7QCI2FM6E3W2P";

describe("ContributorTaxInfo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.getContributorTax = vi.fn();
    mockApi.saveContributorTax = vi.fn();
  });

  test("loads existing tax info on mount", async () => {
    mockApi.getContributorTax.mockResolvedValue({
      success: true,
      data: {
        id: 1,
        walletAddress: WALLET,
        tax_status: "completed",
        tax_id: "12-3456789",
        w9_file_name: "w9.pdf",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-06-01T00:00:00Z",
      },
    });

    render(<ContributorTaxInfo walletAddress={WALLET} />);

    await waitFor(() => {
      const select = screen.getByLabelText(/Tax Status/i) as HTMLSelectElement;
      expect(select.value).toBe("completed");
    });
  });

  test("saves tax status when save button clicked", async () => {
    mockApi.getContributorTax.mockResolvedValue({
      success: true,
      data: null,
    });
    mockApi.saveContributorTax.mockResolvedValue({
      success: true,
      data: { id: 1, walletAddress: WALLET, tax_status: "pending" },
    });

    render(<ContributorTaxInfo walletAddress={WALLET} />);

    await waitFor(() => {
      expect(screen.getByText(/Save Tax Information/i)).toBeDefined();
    });

    fireEvent.click(screen.getByText(/Save Tax Information/i));

    await waitFor(() => {
      expect(mockApi.saveContributorTax).toHaveBeenCalled();
    });
  });

  test("displays error message on save failure", async () => {
    mockApi.getContributorTax.mockResolvedValue({
      success: true,
      data: null,
    });
    mockApi.saveContributorTax.mockRejectedValue(new Error("Network error"));

    render(<ContributorTaxInfo walletAddress={WALLET} />);

    await waitFor(() => {
      expect(screen.getByText(/Save Tax Information/i)).toBeDefined();
    });

    fireEvent.click(screen.getByText(/Save Tax Information/i));

    await waitFor(() => {
      expect(screen.getByText(/Network error/i)).toBeDefined();
    });
  });

  test("renders all tax status options", async () => {
    mockApi.getContributorTax.mockResolvedValue({
      success: true,
      data: null,
    });

    render(<ContributorTaxInfo walletAddress={WALLET} />);

    await waitFor(() => {
      const select = screen.getByLabelText(/Tax Status/i) as HTMLSelectElement;
      expect(select).toBeDefined();
      const options = Array.from(select.options).map((o) => o.value);
      expect(options).toContain("not_collected");
      expect(options).toContain("pending");
      expect(options).toContain("completed");
      expect(options).toContain("exempt");
    });
  });

  test("handles initial load with no existing data", async () => {
    mockApi.getContributorTax.mockResolvedValue({
      success: true,
      data: null,
    });

    render(<ContributorTaxInfo walletAddress={WALLET} />);

    await waitFor(() => {
      const select = screen.getByLabelText(/Tax Status/i) as HTMLSelectElement;
      expect(select.value).toBe("not_collected");
    });
  });
});
