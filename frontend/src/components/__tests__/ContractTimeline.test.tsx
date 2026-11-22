import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { describe, beforeEach, it, expect, vi } from "vitest";
import { ContractTimeline } from "../ContractTimeline";

vi.mock("../../api");
import { api } from "../../api";

const mockGetTransactionHistory = api.getTransactionHistory as any;
const mockGetAuditLog = api.getAuditLog as any;

describe("ContractTimeline (#1424)", () => {
  const contractId = "CCONTRACT1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fetches events with FETCH_LIMIT and renders sorted newest first", async () => {
    mockGetTransactionHistory.mockResolvedValueOnce({
      success: true,
      data: [
        {
          id: 1,
          type: "distribute",
          timestamp: "2026-11-20T10:00:00Z",
          initiatorAddress: "GINITIATOR111111111111111111111111111111111111",
          txHash: "txhash111111111111",
          requestedAmount: "500",
        },
      ],
    });

    mockGetAuditLog.mockResolvedValueOnce({
      success: true,
      data: [
        {
          id: 101,
          timestamp: "2026-11-20T11:00:00Z",
          user: "GAUDITUSER222222222222222222222222222222222222",
          action: "config_updated",
          details: "Royalty split modified",
        },
      ],
    });

    const { container } = render(<ContractTimeline contractId={contractId} />);

    expect(await screen.findByText("Contract Activity")).toBeInTheDocument();
    await waitFor(() => {
      expect(mockGetTransactionHistory).toHaveBeenCalledWith(contractId, 1000, 0);
      expect(mockGetAuditLog).toHaveBeenCalledWith(contractId, 1000, 0);
    });

    // Audit event (11:00) should appear before distribute transaction (10:00)
    await waitFor(() => {
      const cards = container.querySelectorAll(".timeline-card");
      expect(cards.length).toBe(2);
      expect(cards[0]).toHaveTextContent("Audit Event");
      expect(cards[0]).toHaveTextContent("Royalty split modified");
      expect(cards[1]).toHaveTextContent("Distribution");
    });
  });

  it("paginates merged events client-side without duplicates or skipped items", async () => {
    // Generate 15 transactions and 15 audit events (total 30)
    const transactions = Array.from({ length: 15 }, (_, i) => ({
      id: i + 1,
      type: "distribute",
      timestamp: new Date(Date.UTC(2026, 10, 20, 12, 30 - i * 2)).toISOString(),
      initiatorAddress: "GTRANSACTIONINITIATOR1111111111111111111111111",
      txHash: `txhash${i + 1}`,
      requestedAmount: "100",
    }));

    const auditLogs = Array.from({ length: 15 }, (_, i) => ({
      id: 100 + i + 1,
      timestamp: new Date(Date.UTC(2026, 10, 20, 12, 29 - i * 2)).toISOString(),
      user: "GAUDITUSER111111111111111111111111111111111111",
      action: `audit_action_${i + 1}`,
      details: `audit details ${i + 1}`,
    }));

    mockGetTransactionHistory.mockResolvedValueOnce({ success: true, data: transactions });
    mockGetAuditLog.mockResolvedValueOnce({ success: true, data: auditLogs });

    render(<ContractTimeline contractId={contractId} />);

    // Page 1 should show 1–20 of 30
    expect(await screen.findByText("1–20 of 30")).toBeInTheDocument();

    const olderButton = screen.getByRole("button", { name: /Older →/i });
    const newerButton = screen.getByRole("button", { name: /← Newer/i });

    expect(newerButton).toBeDisabled();
    expect(olderButton).not.toBeDisabled();

    // Click to go to page 2
    fireEvent.click(olderButton);

    expect(await screen.findByText("21–30 of 30")).toBeInTheDocument();
    expect(olderButton).toBeDisabled();
    expect(newerButton).not.toBeDisabled();

    // Click to go back to page 1
    fireEvent.click(newerButton);
    expect(await screen.findByText("1–20 of 30")).toBeInTheDocument();
  });

  it("resets pagination offset when filter changes", async () => {
    const transactions = Array.from({ length: 25 }, (_, i) => ({
      id: i + 1,
      type: "distribute",
      timestamp: new Date(Date.UTC(2026, 10, 20, 10, i)).toISOString(),
      initiatorAddress: "GTRANSACTIONINITIATOR1111111111111111111111111",
    }));

    const auditLogs = [
      {
        id: 999,
        timestamp: new Date(Date.UTC(2026, 10, 20, 11, 0)).toISOString(),
        action: "audit_single",
      },
    ];

    mockGetTransactionHistory.mockResolvedValueOnce({ success: true, data: transactions });
    mockGetAuditLog.mockResolvedValueOnce({ success: true, data: auditLogs });

    render(<ContractTimeline contractId={contractId} />);

    expect(await screen.findByText("1–20 of 26")).toBeInTheDocument();

    // Go to page 2
    const olderButton = screen.getByRole("button", { name: /Older →/i });
    fireEvent.click(olderButton);
    expect(await screen.findByText("21–26 of 26")).toBeInTheDocument();

    // Filter by audit
    const auditFilter = screen.getByRole("button", { name: /Audit/i });
    fireEvent.click(auditFilter);

    // Filter count is now 1, offset reset to 0
    expect(await screen.findByText("1–1 of 1")).toBeInTheDocument();
  });

  it("handles error state when API request fails", async () => {
    mockGetTransactionHistory.mockRejectedValueOnce(new Error("Network connection lost"));
    mockGetAuditLog.mockResolvedValueOnce({ success: true, data: [] });

    render(<ContractTimeline contractId={contractId} />);

    expect(await screen.findByText("Network connection lost")).toBeInTheDocument();
  });
});
