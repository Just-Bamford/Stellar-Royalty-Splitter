import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("../api", () => ({
  api: {
    getCollaborators: vi.fn().mockResolvedValue([
      { address: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA", basisPoints: 10000 },
    ]),
    getBalance: vi.fn().mockResolvedValue({ balance: 100 }),
    distributeRoyalties: vi.fn().mockResolvedValue({ hash: "abc123hash" }),
  },
}));

vi.mock("../stellar", () => ({
  signAndSubmitTransaction: vi.fn().mockResolvedValue({ hash: "txhash123" }),
  pollTransactionStatus: vi.fn().mockResolvedValue({ status: "SUCCESS" }),
}));

vi.mock("../context/NetworkContext", () => ({
  useNetwork: () => ({
    network: "testnet",
    networkMismatch: false,
  }),
}));

import DistributeForm from "./DistributeForm";

const WALLET = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA";
const CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const DRAFT_KEY = `srs_distribute_draft:${WALLET}:${CONTRACT}`;

describe("DistributeForm draft persistence & clear on success", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  it("removes localStorage draft when distribution succeeds", async () => {
    localStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({ tokenId: "CDEMO", amount: "50" })
    );

    const onSuccess = vi.fn();
    render(
      <DistributeForm
        contractId={CONTRACT}
        walletAddress={WALLET}
        onSuccess={onSuccess}
      />
    );

    // Draft prompt should appear
    expect(screen.getByText("Restore previous session?")).toBeInTheDocument();

    // Restore draft
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));

    // Click distribute
    const submitBtn = screen.getByTestId("distribute-submit");
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalled();
    });

    // Verify localStorage draft was removed
    expect(localStorage.getItem(DRAFT_KEY)).toBeNull();
  });
});
