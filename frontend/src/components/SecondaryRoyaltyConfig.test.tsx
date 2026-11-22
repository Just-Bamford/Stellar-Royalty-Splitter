import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import SecondaryRoyaltyConfig from "./SecondaryRoyaltyConfig";

vi.mock("../context/NetworkContext", () => ({
  useNetwork: vi.fn(() => ({
    network: "testnet",
    networkMismatch: false,
  })),
}));

vi.mock("../api", () => ({
  api: {
    setRoyaltyRate: vi.fn(),
    confirmTransaction: vi.fn(),
  },
}));

vi.mock("../stellar", () => ({
  signAndSubmitTransaction: vi.fn(),
}));

describe("SecondaryRoyaltyConfig Component (Issue #1422)", () => {
  it("renders 5.00% by default with initial 500 basis points", () => {
    render(
      <SecondaryRoyaltyConfig
        contractId="CONTRACT_123"
        walletAddress="G_WALLET_123"
        onSuccess={vi.fn()}
      />
    );

    expect(screen.getByText("5.00%")).toBeInTheDocument();
  });

  it("shows 0.00% instead of NaN% when input is cleared to empty", () => {
    render(
      <SecondaryRoyaltyConfig
        contractId="CONTRACT_123"
        walletAddress="G_WALLET_123"
        onSuccess={vi.fn()}
      />
    );

    const input = screen.getByRole("spinbutton");
    fireEvent.change(input, { target: { value: "" } });

    expect(screen.getByText("0.00%")).toBeInTheDocument();
    expect(screen.queryByText(/NaN/)).not.toBeInTheDocument();
  });

  it("shows 0.00% instead of NaN% when input is non-numeric", () => {
    render(
      <SecondaryRoyaltyConfig
        contractId="CONTRACT_123"
        walletAddress="G_WALLET_123"
        onSuccess={vi.fn()}
      />
    );

    const input = screen.getByRole("spinbutton");
    fireEvent.change(input, { target: { value: "invalid" } });

    expect(screen.getByText("0.00%")).toBeInTheDocument();
    expect(screen.queryByText(/NaN/)).not.toBeInTheDocument();
  });

  it("correctly calculates percentage for valid inputs (e.g. 1250 bp = 12.50%)", () => {
    render(
      <SecondaryRoyaltyConfig
        contractId="CONTRACT_123"
        walletAddress="G_WALLET_123"
        onSuccess={vi.fn()}
      />
    );

    const input = screen.getByRole("spinbutton");
    fireEvent.change(input, { target: { value: "1250" } });

    expect(screen.getByText("12.50%")).toBeInTheDocument();
  });
});
