import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AdminDashboard } from "./AdminDashboard";
import { api } from "../api";
import type { ContractState } from "../api";

vi.mock("../api", () => ({
  api: {
    getTransactionHistory: vi.fn(),
    getContractVersion: vi.fn(),
    getContractState: vi.fn(),
  },
}));

const CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const ADMIN_ADDRESS = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const contractState: ContractState = {
  contractId: CONTRACT_ID,
  adminAddress: ADMIN_ADDRESS,
  royaltyRate: 750,
  recipients: [],
  balance: "12345",
  tokenId: "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
  network: "Testnet",
  cacheStatus: "live",
  cacheTtlMs: 30_000,
  fetchedAt: "2026-06-25T12:00:00.000Z",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });

  return { promise, resolve };
}

function mockDefaultApi() {
  vi.mocked(api.getTransactionHistory).mockResolvedValue({
    success: true,
    data: [],
    pagination: { limit: 50, offset: 0, total: 0 },
  });
  vi.mocked(api.getContractVersion).mockResolvedValue({
    contractId: CONTRACT_ID,
    version: "1",
  });
  vi.mocked(api.getContractState).mockResolvedValue(contractState);
}

describe("AdminDashboard contract state refresh", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    mockDefaultApi();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  test("loads contract state with cache status and last refreshed timestamp", async () => {
    render(<AdminDashboard contractId={CONTRACT_ID} />);

    expect(await screen.findByText("live")).toBeInTheDocument();
    expect(screen.getByText(ADMIN_ADDRESS)).toBeInTheDocument();
    expect(screen.queryByText("Not refreshed yet")).not.toBeInTheDocument();
    expect(api.getContractState).toHaveBeenCalledWith(CONTRACT_ID, {
      bypassCache: false,
    });
  });

  test("manual refresh bypasses backend cache and disables the button while loading", async () => {
    render(<AdminDashboard contractId={CONTRACT_ID} />);
    await screen.findByText("live");

    const pendingRefresh = deferred<ContractState>();
    vi.mocked(api.getContractState).mockReturnValueOnce(pendingRefresh.promise);

    const refreshButton = screen.getByRole("button", {
      name: /Refresh contract state/i,
    });
    fireEvent.click(refreshButton);

    expect(refreshButton).toBeDisabled();
    expect(screen.getByText("Refreshing")).toBeInTheDocument();
    expect(api.getContractState).toHaveBeenLastCalledWith(CONTRACT_ID, {
      bypassCache: true,
    });

    pendingRefresh.resolve({
      ...contractState,
      cacheStatus: "live",
      fetchedAt: "2026-06-25T12:01:00.000Z",
    });

    await waitFor(() => expect(refreshButton).not.toBeDisabled());
  });

  test("failed refresh shows error status and message", async () => {
    render(<AdminDashboard contractId={CONTRACT_ID} />);
    await screen.findByText("live");

    vi.mocked(api.getContractState).mockRejectedValueOnce(
      new Error("Contract state unavailable"),
    );

    fireEvent.click(screen.getByRole("button", { name: /Refresh contract state/i }));

    expect(await screen.findByText("error")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Contract state unavailable",
    );
  });

  test("cached contract state response shows cached status badge", async () => {
    vi.mocked(api.getContractState).mockResolvedValueOnce({
      ...contractState,
      cacheStatus: "cached",
    });

    render(<AdminDashboard contractId={CONTRACT_ID} />);

    expect(await screen.findByText("cached")).toBeInTheDocument();
  });

  test("auto-refresh interval triggers refresh and persists preference", async () => {
    render(<AdminDashboard contractId={CONTRACT_ID} />);
    await screen.findByText("live");

    vi.useFakeTimers();
    fireEvent.change(screen.getByLabelText(/Auto refresh interval/i), {
      target: { value: "5000" },
    });

    expect(localStorage.getItem("adminDashboardAutoRefreshInterval")).toBe(
      "5000",
    );

    const callsBeforeTick = vi.mocked(api.getContractState).mock.calls.length;
    await vi.advanceTimersByTimeAsync(5_000);

    expect(api.getContractState).toHaveBeenCalledTimes(callsBeforeTick + 1);
    expect(api.getContractState).toHaveBeenLastCalledWith(CONTRACT_ID, {
      bypassCache: false,
    });
  });

  test("remembered never preference prevents auto-refresh", async () => {
    localStorage.setItem("adminDashboardAutoRefreshInterval", "never");

    render(<AdminDashboard contractId={CONTRACT_ID} />);
    await screen.findByText("live");

    vi.useFakeTimers();
    const callsBeforeTick = vi.mocked(api.getContractState).mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);

    expect(api.getContractState).toHaveBeenCalledTimes(callsBeforeTick);
  });
});
