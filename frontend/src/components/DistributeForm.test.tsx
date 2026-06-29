import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import DistributeForm from "./DistributeForm";
import { TransactionProvider } from "../context/TransactionContext";
import { api } from "../api";

// DistributeForm reads transaction phase from TransactionContext, so every
// render needs the provider.
function renderForm(ui: ReactElement) {
  return render(<TransactionProvider>{ui}</TransactionProvider>);
}

vi.mock("../context/NetworkContext", () => ({
  useNetwork: () => ({
    network: "testnet",
    setNetwork: vi.fn(),
  }),
}));

vi.mock("../api", () => ({
  api: {
    getCollaborators: vi.fn().mockResolvedValue([]),
    getContractBalance: vi.fn().mockResolvedValue({ balance: "0" }),
    getPauseState: vi.fn().mockResolvedValue({
      paused: false,
      pauseTimestamp: 0,
      pauseSource: null,
      remainingSeconds: 0,
    }),
    distribute: vi.fn().mockResolvedValue({ xdr: "dummy-xdr", transactionId: 1 }),
    confirmTransaction: vi.fn().mockResolvedValue({ success: true, message: "ok" }),
    getTransactionDetails: vi
      .fn()
      .mockResolvedValue({ success: true, data: { status: "confirmed" } }),
  },
}));

vi.mock("../stellar", () => ({
  signAndSubmitTransaction: vi.fn().mockResolvedValue("signed-hash"),
}));

describe("DistributeForm", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("restores draft from localStorage when present", async () => {
    localStorage.setItem(
      "srs_distribute_draft:test-wallet:test-contract",
      JSON.stringify({ tokenId: "C" + "A".repeat(55), amount: "15" }),
    );

    renderForm(
      <DistributeForm contractId="test-contract" walletAddress="test-wallet" onSuccess={vi.fn()} />,
    );

    expect(await screen.findByText(/Restore previous session\?/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Restore/i })).toBeInTheDocument();
  });

  test("renders recipient breakdown when collaborators are loaded and amount is entered", async () => {
    const mockCollaborators = [
      { address: "GAAAAA" + "A".repeat(49), basisPoints: 5000 },
      { address: "GBBBBBB" + "A".repeat(49), basisPoints: 5000 },
    ];

    (api.getCollaborators as unknown as vi.Mock).mockResolvedValue(mockCollaborators);

    renderForm(
      <DistributeForm contractId="test-contract" walletAddress="test-wallet" onSuccess={vi.fn()} />,
    );

    await waitFor(() => expect(api.getCollaborators).toHaveBeenCalledWith("test-contract"));

    fireEvent.change(screen.getByLabelText(/Token contract address/i), {
      target: { value: "C" + "A".repeat(55) },
    });
    fireEvent.change(screen.getByLabelText(/Amount/i), {
      target: { value: "10" },
    });

    expect(await screen.findByText(/Recipient breakdown/i)).toBeInTheDocument();
    expect(await screen.findAllByText(/50%/i)).toHaveLength(2);
    expect(await screen.findAllByText(/5\s*XLM/i)).toHaveLength(2);
  });

  test("shows a contract-address validation error when the token address is malformed", async () => {
    renderForm(
      <DistributeForm contractId="test-contract" walletAddress="test-wallet" onSuccess={vi.fn()} />,
    );

    fireEvent.change(screen.getByLabelText(/Token contract address/i), {
      target: { value: "invalid-token" },
    });

    expect(await screen.findByText(/Must be a valid Stellar C-address/i)).toBeInTheDocument();
  });

  test("disables submit when the amount exceeds the contract balance", async () => {
    (api.getCollaborators as unknown as vi.Mock).mockResolvedValue([]);
    (api.getContractBalance as unknown as vi.Mock).mockResolvedValue({ balance: "5" });

    renderForm(
      <DistributeForm contractId="test-contract" walletAddress="test-wallet" onSuccess={vi.fn()} />,
    );

    fireEvent.change(screen.getByLabelText(/Token contract address/i), {
      target: { value: "C" + "A".repeat(55) },
    });
    fireEvent.change(screen.getByLabelText(/Amount/i), {
      target: { value: "10" },
    });

    await waitFor(
      () => expect(api.getContractBalance).toHaveBeenCalledWith("test-contract", "C" + "A".repeat(55)),
      { timeout: 1000 },
    );
    expect(await screen.findByText(/Amount exceeds available balance/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Distribute funds/i })).toBeDisabled();
  });

  test("polls for confirmation after submit and reports success (#414)", async () => {
    (api.getContractBalance as unknown as vi.Mock).mockResolvedValue({ balance: "100" });
    // The first poll already reports confirmed (the 5s loop itself is covered
    // by transactionPolling.test.ts), so this stays fast and deterministic.
    (api.getTransactionDetails as unknown as vi.Mock).mockResolvedValue({
      success: true,
      data: { status: "confirmed" },
    });
    const onSuccess = vi.fn();

    renderForm(
      <DistributeForm contractId="test-contract" walletAddress="test-wallet" onSuccess={onSuccess} />,
    );

    fireEvent.change(screen.getByLabelText(/Token contract address/i), {
      target: { value: "C" + "A".repeat(55) },
    });
    await waitFor(() => expect(api.getContractBalance).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText(/Amount/i), { target: { value: "10" } });

    fireEvent.click(screen.getByRole("button", { name: /Distribute funds/i }));

    // Settlement is kicked off and polling drives the confirmed state.
    await waitFor(() => expect(api.confirmTransaction).toHaveBeenCalled());
    await waitFor(() => expect(api.getTransactionDetails).toHaveBeenCalled(), {
      timeout: 8000,
    });
    await waitFor(() => expect(onSuccess).toHaveBeenCalled(), { timeout: 8000 });
    expect(await screen.findByText(/Distributed successfully/i)).toBeInTheDocument();
  });
});
