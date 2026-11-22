import { render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import DistributeSecondaryRoyalties from "./DistributeSecondaryRoyalties";

vi.mock("../context/NetworkContext", () => ({
  useNetwork: vi.fn(() => ({
    network: "testnet",
    networkMismatch: false,
  })),
}));

vi.mock("../api", () => ({
  api: {
    getRoyaltyStats: vi.fn(),
    getSecondaryRoyaltyPool: vi.fn(),
    distributeSecondaryRoyalties: vi.fn(),
  },
}));

vi.mock("../stellar", () => ({
  signAndSubmitTransaction: vi.fn(),
}));

import { api } from "../api";

const mockGetRoyaltyStats = api.getRoyaltyStats as unknown as ReturnType<typeof vi.fn>;
const mockGetSecondaryRoyaltyPool = api.getSecondaryRoyaltyPool as unknown as ReturnType<typeof vi.fn>;

describe("DistributeSecondaryRoyalties Component (Issue #1423)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders loading skeleton placeholders during initial data fetch", async () => {
    // Return unresolved promises to keep component in loading state
    mockGetRoyaltyStats.mockReturnValue(new Promise(() => {}));
    mockGetSecondaryRoyaltyPool.mockReturnValue(new Promise(() => {}));

    render(
      <DistributeSecondaryRoyalties
        contractId="CONTRACT_TEST"
        walletAddress="G_WALLET_TEST"
        onSuccess={vi.fn()}
      />
    );

    expect(screen.getByText("Distribute Secondary Royalties")).toBeInTheDocument();
    expect(screen.getByTestId("distribute-royalties-loading")).toBeInTheDocument();
    expect(screen.queryByLabelText("Token Address")).not.toBeInTheDocument();
  });

  it("renders stats and form together when initial data fetch completes", async () => {
    mockGetRoyaltyStats.mockResolvedValue({
      totalSecondarySales: 42,
      totalRoyaltiesGenerated: "5000",
      lastDistribution: {
        timestamp: "2026-11-20T10:00:00Z",
      },
    });
    mockGetSecondaryRoyaltyPool.mockResolvedValue({
      poolBalance: "250",
    });

    render(
      <DistributeSecondaryRoyalties
        contractId="CONTRACT_TEST"
        walletAddress="G_WALLET_TEST"
        onSuccess={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.queryByTestId("distribute-royalties-loading")).not.toBeInTheDocument();
    });

    expect(screen.getByText("Total Secondary Sales:")).toBeInTheDocument();
    expect(screen.getByText("42")).toBeInTheDocument();
    expect(screen.getByText("250")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("C... (USDC or payment token)")).toBeInTheDocument();
  });
});
