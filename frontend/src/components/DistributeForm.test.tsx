import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import DistributeForm from "./DistributeForm";
import { TransactionProvider } from "../context/TransactionContext";
import { api } from "../api";
import { signAndSubmitTransaction } from "../stellar";

// DistributeForm reads transaction phase from TransactionContext, so every
// render needs the provider.
function renderForm(ui: ReactElement) {
  return render(<TransactionProvider>{ui}</TransactionProvider>);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
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

  test("shows an optimistic pending state immediately after submit", async () => {
    (api.getContractBalance as unknown as vi.Mock).mockResolvedValue({ balance: "100" });
    (api.getTransactionDetails as unknown as vi.Mock).mockResolvedValue({
      success: true,
      data: { status: "confirmed" },
    });
    const distributeRequest = deferred<{ xdr: string; transactionId: number }>();
    (api.distribute as unknown as vi.Mock).mockReturnValueOnce(distributeRequest.promise);
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

    expect(screen.getByTestId("distribution-optimistic")).toHaveAttribute(
      "data-phase",
      "pending",
    );
    expect(screen.getByText(/Distribution submitted\. Preparing the transaction/i)).toBeInTheDocument();
    expect(screen.getByTestId("distribute-submit")).toBeDisabled();

    distributeRequest.resolve({ xdr: "dummy-xdr", transactionId: 1 });
    await waitFor(() => expect(api.confirmTransaction).toHaveBeenCalled());
    await waitFor(() => expect(onSuccess).toHaveBeenCalled(), { timeout: 8000 });
  });

  test("transitions the optimistic state to confirmed and calls onSuccess", async () => {
    (api.getContractBalance as unknown as vi.Mock).mockResolvedValue({ balance: "100" });
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

    expect(screen.getByTestId("distribution-optimistic")).toHaveAttribute(
      "data-phase",
      "pending",
    );
    await waitFor(() => expect(api.confirmTransaction).toHaveBeenCalled());
    await waitFor(() => expect(api.getTransactionDetails).toHaveBeenCalled(), {
      timeout: 8000,
    });
    await waitFor(() => expect(onSuccess).toHaveBeenCalled(), { timeout: 8000 });
    expect(await screen.findByTestId("distribution-optimistic")).toHaveAttribute(
      "data-phase",
      "confirmed",
    );
    expect(await screen.findByText(/Distributed successfully/i)).toBeInTheDocument();
  });

  test("rolls back the optimistic UI if the backend distribution request fails", async () => {
    (api.getContractBalance as unknown as vi.Mock).mockResolvedValue({ balance: "100" });
    (api.distribute as unknown as vi.Mock).mockRejectedValueOnce(new Error("backend unavailable"));

    renderForm(
      <DistributeForm contractId="test-contract" walletAddress="test-wallet" onSuccess={vi.fn()} />,
    );

    fireEvent.change(screen.getByLabelText(/Token contract address/i), {
      target: { value: "C" + "A".repeat(55) },
    });
    await waitFor(() => expect(api.getContractBalance).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText(/Amount/i), { target: { value: "10" } });

    fireEvent.click(screen.getByRole("button", { name: /Distribute funds/i }));

    expect(screen.getByTestId("distribution-optimistic")).toHaveAttribute(
      "data-phase",
      "pending",
    );
    expect(await screen.findByTestId("tx-error-message")).toHaveTextContent(
      /backend unavailable/i,
    );
    await waitFor(() => expect(screen.queryByTestId("distribution-optimistic")).toBeNull());
    expect(screen.getByLabelText(/Token contract address/i)).toHaveValue(
      "C" + "A".repeat(55),
    );
    expect(screen.getByLabelText(/Amount/i)).toHaveValue("10");
  });

  test("rolls back the optimistic UI if signing fails after submission", async () => {
    (api.getContractBalance as unknown as vi.Mock).mockResolvedValue({ balance: "100" });
    (signAndSubmitTransaction as unknown as vi.Mock).mockRejectedValueOnce(new Error("wallet rejected"));
    const distributeRequest = deferred<{ xdr: string; transactionId: number }>();
    (api.distribute as unknown as vi.Mock).mockReturnValueOnce(distributeRequest.promise);

    renderForm(
      <DistributeForm contractId="test-contract" walletAddress="test-wallet" onSuccess={vi.fn()} />,
    );

    fireEvent.change(screen.getByLabelText(/Token contract address/i), {
      target: { value: "C" + "A".repeat(55) },
    });
    await waitFor(() => expect(api.getContractBalance).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText(/Amount/i), { target: { value: "10" } });

    fireEvent.click(screen.getByRole("button", { name: /Distribute funds/i }));

    expect(screen.getByTestId("distribution-optimistic")).toHaveAttribute(
      "data-phase",
      "pending",
    );
    distributeRequest.resolve({ xdr: "dummy-xdr", transactionId: 1 });
    expect(await screen.findByTestId("tx-error-message")).toHaveTextContent(/wallet rejected/i);
    await waitFor(() => expect(screen.queryByTestId("distribution-optimistic")).toBeNull());
    expect(screen.getByLabelText(/Token contract address/i)).toHaveValue(
      "C" + "A".repeat(55),
    );
    expect(screen.getByLabelText(/Amount/i)).toHaveValue("10");
  });
});
