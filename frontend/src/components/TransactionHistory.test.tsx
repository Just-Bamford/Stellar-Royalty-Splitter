/**
 * Tests for TransactionHistory loading states (#714), transaction
 * lifecycle status display / refresh (#712), filtering/search (#754), and
 * the error retry action (#747).
 *
 * Run with `npx vitest run src/components/TransactionHistory.test.tsx` from
 * frontend/ — this repo's other *.test.tsx files run the same way via Vitest.
 */

import type { ComponentProps } from "react";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { describe, beforeEach, test, expect, vi } from "vitest";
import { TransactionHistory } from "./TransactionHistory";
import { NetworkProvider } from "../context/NetworkContext";

vi.mock("../api");

import { api } from "../api";

// TransactionHistory reads network state via useNetwork(), so every render
// needs a NetworkProvider ancestor (jsdom has no window.freighter, so
// NetworkProvider's Freighter polling is a harmless no-op here).
function renderHistory(props: ComponentProps<typeof TransactionHistory>) {
  return render(
    <NetworkProvider>
      <TransactionHistory {...props} />
    </NetworkProvider>,
  );
}

const mockGetTransactionHistory = api.getTransactionHistory as any;
const mockConfirmTransaction = api.confirmTransaction as any;

const MOCK_CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const mockTransactions = [
  {
    id: 1,
    txHash: "abc123",
    contractId: MOCK_CONTRACT,
    type: "distribute" as const,
    initiatorAddress: "GALAXY1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZAAAA",
    requestedAmount: "1000",
    tokenId: "native",
    timestamp: new Date().toISOString(),
    blockTime: new Date().toISOString(),
    status: "confirmed" as const,
    errorMessage: null,
  },
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe("TransactionHistory error retry (#747)", () => {
  test("shows an error message with a Retry button when the fetch fails", async () => {
    mockGetTransactionHistory.mockRejectedValueOnce(new Error("Network error"));
    renderHistory({ contractId: MOCK_CONTRACT });

    await waitFor(() => {
      expect(screen.getByTestId("history-error")).toBeTruthy();
    });
    expect(screen.getByText("Network error")).toBeTruthy();
    expect(screen.getByRole("button", { name: /retry/i })).toBeTruthy();
    // The skeleton isn't shown alongside the error state.
    expect(screen.queryByRole("status")).toBeNull();
  });

  test("re-fetches and clears the error when Retry is clicked", async () => {
    mockGetTransactionHistory.mockRejectedValueOnce(new Error("Network error"));
    renderHistory({ contractId: MOCK_CONTRACT });

    await waitFor(() => {
      expect(screen.getByTestId("history-error")).toBeTruthy();
    });

    mockGetTransactionHistory.mockResolvedValueOnce({
      success: true,
      data: mockTransactions,
      pagination: { limit: 50, offset: 0, total: 1 },
    });
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));

    await waitFor(() => {
      expect(screen.queryByTestId("history-error")).toBeNull();
      expect(screen.getByText(/Showing/i)).toBeTruthy();
    });
    expect(mockGetTransactionHistory).toHaveBeenCalledTimes(2);
  });
});

describe("TransactionHistory loading states", () => {
  it("shows a skeleton placeholder (not blank) on initial load", () => {
    mockGetTransactionHistory.mockReturnValue(
      new Promise(() => {
        /* never resolves */
      }),
    );
    const { container } = renderHistory({ contractId: MOCK_CONTRACT });

    expect(container.querySelectorAll(".list-skeleton-item").length).toBe(5);
    expect(screen.getByRole("status")).toBeTruthy();
  });

  it("replaces the skeleton with the transactions table once data loads", async () => {
    mockGetTransactionHistory.mockResolvedValue({
      success: true,
      data: mockTransactions,
      pagination: { limit: 50, offset: 0, total: 1 },
    });

    renderHistory({ contractId: MOCK_CONTRACT });

    expect(screen.getByRole("status")).toBeTruthy();

    await waitFor(() => {
      expect(screen.queryByRole("status")).toBeNull();
    });

    expect(screen.getByText(/Showing/i)).toBeTruthy();
  });

  it("shows the empty state (not a skeleton) once loaded with no results", async () => {
    mockGetTransactionHistory.mockResolvedValue({
      success: true,
      data: [],
      pagination: { limit: 50, offset: 0, total: 0 },
    });

    renderHistory({ contractId: MOCK_CONTRACT });

    await waitFor(() => {
      expect(screen.getByTestId("history-empty-state")).toBeTruthy();
    });

    expect(screen.queryByRole("status")).toBeNull();
  });

  it("keeps existing rows visible (no skeleton) while refreshing", async () => {
    mockGetTransactionHistory.mockResolvedValue({
      success: true,
      data: mockTransactions,
      pagination: { limit: 50, offset: 0, total: 1 },
    });

    renderHistory({ contractId: MOCK_CONTRACT });

    await waitFor(() => {
      expect(screen.getByText(/Showing/i)).toBeTruthy();
    });

    // Trigger a refresh that never resolves.
    mockGetTransactionHistory.mockReturnValue(
      new Promise(() => {
        /* never resolves */
      }),
    );
    const refreshBtn = screen.getByText("Refresh");
    fireEvent.click(refreshBtn);

    await waitFor(() => {
      expect(screen.getByText("Refreshing...")).toBeTruthy();
    });

    // The already-loaded table stays put; no skeleton replaces it.
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByText(/Showing/i)).toBeTruthy();
  });
});

describe("TransactionHistory filtering and search (#754)", () => {
  const txA = {
    id: 10,
    txHash: "txhashaaa",
    contractId: MOCK_CONTRACT,
    type: "distribute" as const,
    initiatorAddress: "GALICE0000000000000000000000000000000000000000",
    requestedAmount: "1000",
    tokenId: "native",
    timestamp: new Date("2026-01-01T00:00:00Z").toISOString(),
    blockTime: new Date("2026-01-01T00:00:00Z").toISOString(),
    status: "confirmed" as const,
    errorMessage: null,
  };
  const txB = {
    id: 11,
    txHash: "txhashbbb",
    contractId: MOCK_CONTRACT,
    type: "secondary_distribute" as const,
    initiatorAddress: "GBOB0000000000000000000000000000000000000000000",
    requestedAmount: "5000",
    tokenId: "USDC",
    timestamp: new Date("2026-02-01T00:00:00Z").toISOString(),
    blockTime: new Date("2026-02-01T00:00:00Z").toISOString(),
    status: "confirmed" as const,
    errorMessage: null,
  };

  beforeEach(() => {
    mockGetTransactionHistory.mockResolvedValue({
      success: true,
      data: [txA, txB],
      pagination: { limit: 10, offset: 0, total: 2 },
    });
  });

  it("filters displayed rows by searching a transaction ID", async () => {
    renderHistory({ contractId: MOCK_CONTRACT });

    await waitFor(() => expect(screen.getByText(/Showing/i)).toBeTruthy());

    fireEvent.click(screen.getByText("Filters"));
    const searchInput = screen.getByLabelText(
      "Search by transaction ID or collaborator address",
    );
    fireEvent.change(searchInput, { target: { value: "txhashaaa" } });

    await waitFor(() => {
      expect(screen.getByLabelText(/View transaction txhashaaa/i)).toBeTruthy();
    });
    expect(screen.queryByLabelText(/View transaction txhashbbb/i)).toBeNull();
  });

  it("filters displayed rows by collaborator address search", async () => {
    renderHistory({ contractId: MOCK_CONTRACT });

    await waitFor(() => expect(screen.getByText(/Showing/i)).toBeTruthy());

    fireEvent.click(screen.getByText("Filters"));
    const searchInput = screen.getByLabelText(
      "Search by transaction ID or collaborator address",
    );
    fireEvent.change(searchInput, { target: { value: "GBOB" } });

    await waitFor(() => {
      expect(screen.getByTitle(txB.initiatorAddress)).toBeTruthy();
    });
    expect(screen.queryByTitle(txA.initiatorAddress)).toBeNull();
  });

  it("resets search, token, category and sort state on 'Reset all filters'", async () => {
    renderHistory({ contractId: MOCK_CONTRACT });

    await waitFor(() => expect(screen.getByText(/Showing/i)).toBeTruthy());

    fireEvent.click(screen.getByText("Filters"));
    const searchInput = screen.getByLabelText(
      "Search by transaction ID or collaborator address",
    );
    fireEvent.change(searchInput, { target: { value: "GBOB" } });

    await waitFor(() => {
      expect(screen.queryByTitle(txA.initiatorAddress)).toBeNull();
    });

    fireEvent.click(screen.getByText("Reset all filters"));

    await waitFor(() => {
      expect(screen.getByTitle(txA.initiatorAddress)).toBeTruthy();
      expect(screen.getByTitle(txB.initiatorAddress)).toBeTruthy();
    });
  });
});

describe("TransactionHistory lifecycle status (#712)", () => {
  const pendingTx = {
    id: 2,
    txHash: "def456",
    contractId: MOCK_CONTRACT,
    type: "distribute" as const,
    initiatorAddress: "GALAXY1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZAAAA",
    requestedAmount: "500",
    tokenId: "native",
    timestamp: new Date().toISOString(),
    blockTime: null,
    status: "pending" as const,
    errorMessage: null,
  };

  it("shows a 'Delayed' badge for a pending transaction older than the threshold", async () => {
    const oldPendingTx = {
      ...pendingTx,
      // 10 minutes old — past the 5-minute delayed threshold.
      timestamp: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    };
    mockGetTransactionHistory.mockResolvedValue({
      success: true,
      data: [oldPendingTx],
      pagination: { limit: 50, offset: 0, total: 1 },
    });

    renderHistory({ contractId: MOCK_CONTRACT });

    await waitFor(() => {
      expect(screen.getByText("Delayed")).toBeTruthy();
    });
  });

  it("shows a plain 'pending' badge for a recently submitted pending transaction", async () => {
    mockGetTransactionHistory.mockResolvedValue({
      success: true,
      data: [pendingTx],
      pagination: { limit: 50, offset: 0, total: 1 },
    });

    renderHistory({ contractId: MOCK_CONTRACT });

    await waitFor(() => {
      expect(screen.getByText("pending")).toBeTruthy();
    });
    expect(screen.queryByText("Delayed")).toBeNull();
  });

  it("shows an 'Unknown' badge for a status outside pending/confirmed/failed", async () => {
    const weirdStatusTx = {
      ...mockTransactions[0],
      status: "something_new" as never,
    };
    mockGetTransactionHistory.mockResolvedValue({
      success: true,
      data: [weirdStatusTx],
      pagination: { limit: 50, offset: 0, total: 1 },
    });

    renderHistory({ contractId: MOCK_CONTRACT });

    await waitFor(() => {
      expect(screen.getByText("Unknown")).toBeTruthy();
    });
  });

  it("offers a per-row refresh action only for pending transactions", async () => {
    mockGetTransactionHistory.mockResolvedValue({
      success: true,
      data: [mockTransactions[0], pendingTx],
      pagination: { limit: 50, offset: 0, total: 2 },
    });

    renderHistory({ contractId: MOCK_CONTRACT });

    await waitFor(() => {
      expect(screen.getByText(/Showing/i)).toBeTruthy();
    });

    // Exactly one row (the pending one) gets a refresh action.
    expect(
      screen.getByLabelText(
        `Refresh status for transaction ${pendingTx.txHash}`,
      ),
    ).toBeTruthy();
    expect(
      screen.queryByLabelText(
        `Refresh status for transaction ${mockTransactions[0].txHash}`,
      ),
    ).toBeNull();
  });

  it("refreshes a pending transaction's status and re-fetches history on success", async () => {
    mockGetTransactionHistory.mockResolvedValue({
      success: true,
      data: [pendingTx],
      pagination: { limit: 50, offset: 0, total: 1 },
    });
    mockConfirmTransaction.mockResolvedValue({
      success: true,
      message: "Transaction def456... marked as confirmed",
    });

    renderHistory({ contractId: MOCK_CONTRACT });

    await waitFor(() => {
      expect(screen.getByText(/Showing/i)).toBeTruthy();
    });

    const refreshBtn = screen.getByLabelText(
      `Refresh status for transaction ${pendingTx.txHash}`,
    );
    fireEvent.click(refreshBtn);

    expect(mockConfirmTransaction).toHaveBeenCalledWith(pendingTx.txHash, {
      status: "confirmed",
      transactionId: pendingTx.id,
    });

    await waitFor(() => {
      expect(
        screen.getByText("Transaction def456... marked as confirmed"),
      ).toBeTruthy();
    });

    // History is re-fetched after a successful refresh (initial load + refresh).
    expect(mockGetTransactionHistory).toHaveBeenCalledTimes(2);
  });

  it("treats a failed refresh (e.g. Horizon timeout) as 'still pending', not an error", async () => {
    mockGetTransactionHistory.mockResolvedValue({
      success: true,
      data: [pendingTx],
      pagination: { limit: 50, offset: 0, total: 1 },
    });
    mockConfirmTransaction.mockRejectedValue(
      new Error("Transaction not confirmed within 60000ms"),
    );

    renderHistory({ contractId: MOCK_CONTRACT });

    await waitFor(() => {
      expect(screen.getByText(/Showing/i)).toBeTruthy();
    });

    const refreshBtn = screen.getByLabelText(
      `Refresh status for transaction ${pendingTx.txHash}`,
    );
    fireEvent.click(refreshBtn);

    await waitFor(() => {
      expect(
        screen.getByText(/Still pending — Horizon hasn't confirmed this yet/i),
      ).toBeTruthy();
    });

    // No generic error banner — this is an expected, non-alarming outcome.
    expect(screen.queryByText(/^Error/i)).toBeNull();
    // Only the initial load fetched history; a failed refresh doesn't
    // re-fetch (there's nothing new to show).
    expect(mockGetTransactionHistory).toHaveBeenCalledTimes(1);
  });
});
