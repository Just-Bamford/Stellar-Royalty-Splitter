import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, beforeEach, test, expect, vi } from "vitest";
import DistributeForm from "../DistributeForm";
import { api } from "../../api";
import { signAndSubmitTransaction } from "../../stellar";

vi.mock("../../api");
vi.mock("../../stellar", () => ({
  signAndSubmitTransaction: vi.fn(),
}));
vi.mock("../../context/NetworkContext", () => ({
  useNetwork: () => ({ network: "testnet", networkMismatch: false }),
}));
vi.mock("../../context/TransactionContext", () => ({
  useTransaction: () => ({
    current: null,
    beginTransaction: vi.fn(),
    updatePhase: vi.fn(),
    reset: vi.fn(),
  }),
  useIsTransactionInFlight: () => false,
}));

const mockApi = api as any;
const mockSign = signAndSubmitTransaction as any;
const CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const TOKEN = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const WALLET = "GAPTAQKSMN2ILFVHXDE5V274BUPC6QCRMJZYJFNGW7ENT2X3BQOS4M3C";
const DRAFT_KEY = `srs_distribute_draft:${WALLET}:${CONTRACT}`;

const defaultProps = {
  contractId: CONTRACT,
  walletAddress: WALLET,
  onSuccess: vi.fn(),
};

describe("DistributeForm — draft persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mockApi.getCollaborators.mockResolvedValue([]);
    mockApi.getContractBalance.mockResolvedValue({ balance: "100" });
    mockApi.distribute.mockResolvedValue({ transactionId: "tx-1", xdr: "XDR" });
    mockApi.confirmTransaction.mockResolvedValue({});
    mockSign.mockResolvedValue("HASH-1");
  });

  test("restores a saved draft on mount", async () => {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ tokenId: TOKEN, amount: "7" }));
    render(<DistributeForm {...defaultProps} />);

    fireEvent.click(await screen.findByRole("button", { name: "Restore" }));

    expect(screen.getByLabelText("Token contract address")).toHaveValue(TOKEN);
    expect(screen.getByLabelText("Amount")).toHaveValue("7");
  });

  test("removes the draft after a successful distribution", async () => {
    render(<DistributeForm {...defaultProps} onSuccess={defaultProps.onSuccess} />);

    fireEvent.change(screen.getByLabelText("Token contract address"), {
      target: { value: TOKEN },
    });
    await waitFor(() => expect(screen.getByLabelText("Amount")).not.toBeDisabled());
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "5" } });

    // Debounced draft write must land before submitting, so the test proves
    // a draft existed and was then cleared by the successful submission.
    await waitFor(() => expect(localStorage.getItem(DRAFT_KEY)).not.toBeNull());

    const submit = screen.getByTestId("distribute-submit");
    await waitFor(() => expect(submit).not.toBeDisabled());
    fireEvent.click(submit);

    await waitFor(() => expect(defaultProps.onSuccess).toHaveBeenCalledTimes(1));
    expect(localStorage.getItem(DRAFT_KEY)).toBeNull();
    expect(screen.getByLabelText("Token contract address")).toHaveValue("");
    expect(screen.getByLabelText("Amount")).toHaveValue("");
  });

  test("keeps the draft when signing fails", async () => {
    mockSign.mockRejectedValue(new Error("User rejected"));
    render(<DistributeForm {...defaultProps} />);

    fireEvent.change(screen.getByLabelText("Token contract address"), {
      target: { value: TOKEN },
    });
    await waitFor(() => expect(screen.getByLabelText("Amount")).not.toBeDisabled());
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "5" } });
    await waitFor(() => expect(localStorage.getItem(DRAFT_KEY)).not.toBeNull());

    const submit = screen.getByTestId("distribute-submit");
    await waitFor(() => expect(submit).not.toBeDisabled());
    fireEvent.click(submit);

    await waitFor(() => expect(mockSign).toHaveBeenCalled());
    expect(defaultProps.onSuccess).not.toHaveBeenCalled();
    expect(localStorage.getItem(DRAFT_KEY)).not.toBeNull();
  });
});
