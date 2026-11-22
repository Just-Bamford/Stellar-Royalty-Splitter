import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom";
import DistributeSecondaryRoyalties from "../DistributeSecondaryRoyalties";
import * as NetworkContext from "../../context/NetworkContext";
import { api } from "../../api";
import * as stellar from "../../stellar";

describe("DistributeSecondaryRoyalties Token ID Validation (#1405)", () => {
  const validTokenAddress = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const invalidTokenAddress = "not-a-valid-token";
  const contractId = "CB1111111111111111111111111111111111111111111111111111111111";
  const walletAddress = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

  beforeEach(() => {
    vi.clearAllMocks();

    vi.spyOn(NetworkContext, "useNetwork").mockReturnValue({
      network: "testnet",
      setNetwork: vi.fn(),
      walletNetworkName: "TESTNET",
      networkMismatch: false,
      refreshWalletNetwork: vi.fn(),
    });

    vi.spyOn(api, "getRoyaltyStats").mockResolvedValue({
      totalDistributed: "1000",
      pendingRoyalties: "500",
      totalTransactions: 10,
    } as any);

    vi.spyOn(api, "getSecondaryRoyaltyPool").mockResolvedValue({
      poolBalance: "250",
    } as any);

    vi.spyOn(api, "distributeSecondaryRoyalties").mockResolvedValue({
      xdr: "AAAA...",
      numberOfSales: 3,
      totalRoyalties: "150",
    } as any);

    vi.spyOn(stellar, "signAndSubmitTransaction").mockResolvedValue({
      status: "SUCCESS",
      txHash: "abcdef",
    } as any);
  });

  it("shows inline error when invalid token address is blurred", async () => {
    render(
      <DistributeSecondaryRoyalties
        contractId={contractId}
        walletAddress={walletAddress}
        onSuccess={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByText("250")).toBeInTheDocument();
    });

    const input = screen.getByPlaceholderText(/C\.\.\./i);
    fireEvent.change(input, { target: { value: invalidTokenAddress } });
    fireEvent.blur(input);

    expect(
      screen.getAllByText("Please enter a valid token contract address (C..., 56 chars).").length
    ).toBeGreaterThanOrEqual(1);
  });

  it("rejects submission and does not call API when token address is invalid", async () => {
    render(
      <DistributeSecondaryRoyalties
        contractId={contractId}
        walletAddress={walletAddress}
        onSuccess={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByText("250")).toBeInTheDocument();
    });

    const input = screen.getByPlaceholderText(/C\.\.\./i);
    fireEvent.change(input, { target: { value: invalidTokenAddress } });

    const submitBtn = screen.getByRole("button", { name: /Distribute Royalties/i });
    fireEvent.click(submitBtn);

    expect(
      screen.getAllByText("Please enter a valid token contract address (C..., 56 chars).").length
    ).toBeGreaterThanOrEqual(1);
    expect(api.distributeSecondaryRoyalties).not.toHaveBeenCalled();
  });

  it("accepts valid C-address and proceeds with distribution", async () => {
    const onSuccessMock = vi.fn();
    render(
      <DistributeSecondaryRoyalties
        contractId={contractId}
        walletAddress={walletAddress}
        onSuccess={onSuccessMock}
      />
    );

    await waitFor(() => {
      expect(screen.getByText("250")).toBeInTheDocument();
    });

    const input = screen.getByPlaceholderText(/C\.\.\./i);
    fireEvent.change(input, { target: { value: validTokenAddress } });

    const submitBtn = screen.getByRole("button", { name: /Distribute Royalties/i });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(api.distributeSecondaryRoyalties).toHaveBeenCalledWith({
        contractId,
        walletAddress,
        tokenId: validTokenAddress,
      });
    });
  });
});
