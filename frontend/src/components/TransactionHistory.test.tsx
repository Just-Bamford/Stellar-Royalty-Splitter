import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { TransactionHistory } from "./TransactionHistory";
import { api } from "../api";

vi.mock("../api", () => ({
  api: {
    getTransactionHistory: vi.fn(),
    getTransactionDetails: vi.fn(),
  },
}));

const mockedHistory = api.getTransactionHistory as unknown as ReturnType<typeof vi.fn>;

const DAY = 86_400_000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

const TXNS = [
  { id: 1, txHash: "AAAA1111aaaa1111", contractId: "C", type: "distribute", initiatorAddress: "GAAAA", requestedAmount: "100", tokenId: null, timestamp: iso(0), blockTime: null, status: "confirmed", errorMessage: null },
  { id: 2, txHash: "BBBB2222bbbb2222", contractId: "C", type: "distribute", initiatorAddress: "GBBBB", requestedAmount: "200", tokenId: null, timestamp: iso(10 * DAY), blockTime: null, status: "pending", errorMessage: null },
  { id: 3, txHash: "CCCC3333cccc3333", contractId: "C", type: "distribute", initiatorAddress: "GAAAA", requestedAmount: "300", tokenId: null, timestamp: iso(40 * DAY), blockTime: null, status: "failed", errorMessage: "boom" },
  { id: 4, txHash: "AAAA4444aaaa4444", contractId: "C", type: "distribute", initiatorAddress: "GCCCC", requestedAmount: "400", tokenId: null, timestamp: iso(100 * DAY), blockTime: null, status: "confirmed", errorMessage: null },
  { id: 5, txHash: null, contractId: "C", type: "initialize", initiatorAddress: "GBBBB", requestedAmount: null, tokenId: null, timestamp: iso(0), blockTime: null, status: "pending", errorMessage: null },
];

function count(): string {
  return screen.getByTestId("tx-result-count").textContent ?? "";
}

async function renderHistory() {
  render(<TransactionHistory contractId="CABC" />);
  await waitFor(() => expect(screen.getByTestId("tx-result-count")).toBeInTheDocument());
}

describe("TransactionHistory filters (#413)", () => {
  beforeEach(() => {
    mockedHistory.mockReset();
    mockedHistory.mockResolvedValue({
      data: TXNS,
      pagination: { limit: 10, offset: 0, total: 5 },
    });
    window.history.replaceState(null, "", "/");
  });

  afterEach(() => {
    window.history.replaceState(null, "", "/");
  });

  test("shows the result count out of the server total", async () => {
    await renderHistory();
    expect(count()).toBe("5 of 5 transactions");
  });

  test("filters by transaction hash substring (debounced)", async () => {
    await renderHistory();
    fireEvent.change(screen.getByLabelText("Search by transaction hash"), {
      target: { value: "AAAA" },
    });
    // Debounced: not applied immediately.
    expect(count()).toBe("5 of 5 transactions");
    await waitFor(() => expect(count()).toBe("2 of 5 transactions"));
  });

  test("filters by status", async () => {
    await renderHistory();
    fireEvent.change(screen.getByLabelText("Filter by status"), { target: { value: "failed" } });
    expect(count()).toBe("1 of 5 transactions");
  });

  test("filters by initiator", async () => {
    await renderHistory();
    fireEvent.change(screen.getByLabelText("Filter by initiator"), { target: { value: "GAAAA" } });
    expect(count()).toBe("2 of 5 transactions");
  });

  test("filters by date range (last 7 days)", async () => {
    await renderHistory();
    fireEvent.change(screen.getByLabelText("Filter by date range"), { target: { value: "7" } });
    // Only the two "now" transactions fall within 7 days.
    expect(count()).toBe("2 of 5 transactions");
  });

  test("combines status and initiator filters", async () => {
    await renderHistory();
    fireEvent.change(screen.getByLabelText("Filter by status"), { target: { value: "confirmed" } });
    fireEvent.change(screen.getByLabelText("Filter by initiator"), { target: { value: "GAAAA" } });
    expect(count()).toBe("1 of 5 transactions"); // only tx1
  });

  test("shows active-filter badges and a single badge can be cleared", async () => {
    await renderHistory();
    fireEvent.change(screen.getByLabelText("Filter by status"), { target: { value: "failed" } });
    const badges = screen.getByLabelText("Active filters");
    expect(within(badges).getByText(/Status: failed/)).toBeInTheDocument();

    fireEvent.click(within(badges).getByLabelText("Clear status filter"));
    expect(count()).toBe("5 of 5 transactions");
  });

  test("clear-all resets every filter", async () => {
    await renderHistory();
    fireEvent.change(screen.getByLabelText("Filter by status"), { target: { value: "failed" } });
    fireEvent.change(screen.getByLabelText("Filter by initiator"), { target: { value: "GAAAA" } });
    expect(count()).toBe("1 of 5 transactions");

    fireEvent.click(screen.getByRole("button", { name: /clear all/i }));
    expect(count()).toBe("5 of 5 transactions");
  });

  test("persists filters in the URL query string", async () => {
    await renderHistory();
    fireEvent.change(screen.getByLabelText("Filter by status"), { target: { value: "failed" } });
    await waitFor(() =>
      expect(new URLSearchParams(window.location.search).get("status")).toBe("failed"),
    );
  });

  test("shows a no-match message when filters exclude everything", async () => {
    await renderHistory();
    fireEvent.change(screen.getByLabelText("Filter by initiator"), { target: { value: "GAAAA" } });
    fireEvent.change(screen.getByLabelText("Filter by status"), { target: { value: "pending" } });
    expect(count()).toBe("0 of 5 transactions");
    expect(screen.getByText(/No transactions match your filters/i)).toBeInTheDocument();
  });
});
