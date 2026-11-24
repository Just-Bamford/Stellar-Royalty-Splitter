import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { EarningsHistoryChart } from "../EarningsHistoryChart";
import { api } from "../../api";
import { mergeSnapshots, readCachedSnapshots } from "../../lib/earnings-snapshots-db";

vi.mock("../../api");
vi.mock("../../lib/earnings-snapshots-db", () => ({
  mergeSnapshots: vi.fn(),
  readCachedSnapshots: vi.fn(),
}));
vi.mock("../../context/SettingsContext", () => ({
  useSettings: () => ({ settings: { displayCurrency: "USD" } }),
}));

const mockApi = api as any;
const WALLET = "GA7E6YDRQKJ2JNOG27UPSCQ3FQ6U4X3QQGJKHNGF23T7QCI2FM6E3W2P";
const CONTRACT = "CCONTRACTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const today = new Date().toISOString().slice(0, 10);
const cachedRows = [{ date: today, contractId: CONTRACT, amount: 12 }];

const OFFLINE_TEXT = "You appear to be offline. Showing cached data.";

describe("EarningsHistoryChart offline state (#1396)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.getEarningsHistory = vi.fn();
    vi.mocked(mergeSnapshots).mockImplementation(async (_wallet, rows) => rows as any);
  });

  test("shows the offline banner with cached data when the request fails", async () => {
    mockApi.getEarningsHistory.mockRejectedValue(new TypeError("Failed to fetch"));
    vi.mocked(readCachedSnapshots).mockResolvedValue(cachedRows);

    render(<EarningsHistoryChart walletAddress={WALLET} />);

    expect(await screen.findByText(OFFLINE_TEXT)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    // Cached data is rendered instead of the error state.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("Period total")).toBeInTheDocument();
  });

  test("shows the error (not the offline banner) when there is no cached data", async () => {
    mockApi.getEarningsHistory.mockRejectedValue(new TypeError("Failed to fetch"));
    vi.mocked(readCachedSnapshots).mockResolvedValue([]);

    render(<EarningsHistoryChart walletAddress={WALLET} />);

    expect(await screen.findByRole("alert")).toHaveTextContent(/Unable to load earnings history/);
    expect(screen.queryByText(OFFLINE_TEXT)).not.toBeInTheDocument();
  });

  test("does not show the offline banner when the request succeeds", async () => {
    mockApi.getEarningsHistory.mockResolvedValue({
      success: true,
      data: { snapshots: cachedRows, events: [], contracts: [CONTRACT] },
    });

    render(<EarningsHistoryChart walletAddress={WALLET} />);

    expect(await screen.findByText("Period total")).toBeInTheDocument();
    expect(screen.queryByText(OFFLINE_TEXT)).not.toBeInTheDocument();
  });

  test("Retry refetches and clears the banner once the API is reachable", async () => {
    mockApi.getEarningsHistory
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce({
        success: true,
        data: { snapshots: cachedRows, events: [], contracts: [CONTRACT] },
      });
    vi.mocked(readCachedSnapshots).mockResolvedValue(cachedRows);

    render(<EarningsHistoryChart walletAddress={WALLET} />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));

    await waitFor(() => expect(screen.queryByText(OFFLINE_TEXT)).not.toBeInTheDocument());
    expect(mockApi.getEarningsHistory).toHaveBeenCalledTimes(2);
  });

  test("refetches automatically when the browser comes back online", async () => {
    mockApi.getEarningsHistory
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce({
        success: true,
        data: { snapshots: cachedRows, events: [], contracts: [CONTRACT] },
      });
    vi.mocked(readCachedSnapshots).mockResolvedValue(cachedRows);

    render(<EarningsHistoryChart walletAddress={WALLET} />);
    await screen.findByText(OFFLINE_TEXT);

    act(() => {
      window.dispatchEvent(new Event("online"));
    });

    await waitFor(() => expect(screen.queryByText(OFFLINE_TEXT)).not.toBeInTheDocument());
    expect(mockApi.getEarningsHistory).toHaveBeenCalledTimes(2);
  });
});
