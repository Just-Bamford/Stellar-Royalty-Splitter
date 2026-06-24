import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import DistributeForm from "./DistributeForm";
import { api } from "../api";

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
    distribute: vi.fn().mockResolvedValue({ xdr: "dummy-xdr", transactionId: 1 }),
    confirmTransaction: vi.fn().mockResolvedValue({ success: true, message: "ok" }),
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

    render(
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

    render(
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
    render(
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

    render(
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
});
