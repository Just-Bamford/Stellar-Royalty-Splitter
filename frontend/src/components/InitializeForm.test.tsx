import { describe, expect, test, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import InitializeForm from "./InitializeForm";

vi.mock("../context/NetworkContext", () => ({
  useNetwork: () => ({
    network: "testnet",
    setNetwork: vi.fn(),
  }),
}));

describe("InitializeForm", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  test("renders a collaborator row and action buttons", () => {
    render(
      <InitializeForm contractId="dummy" walletAddress="GABC" onSuccess={vi.fn()} />,
    );

    expect(screen.getByPlaceholderText(/Wallet address \(G\.\.\./i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/% \(0–100\)/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Initialize contract/i })).toBeDisabled();
  });

  test("shows address validation error for invalid Stellar addresses", () => {
    render(
      <InitializeForm contractId="dummy" walletAddress="GABC" onSuccess={vi.fn()} />,
    );

    const addressInput = screen.getByPlaceholderText(/Wallet address \(G\.\.\./i);
    fireEvent.change(addressInput, { target: { value: "not-a-valid-address" } });
    fireEvent.blur(addressInput);

    expect(screen.getByText(/Must be a valid Stellar address/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Initialize contract/i })).toBeDisabled();
  });

  test("shows percentage validation error for too large values", () => {
    render(
      <InitializeForm contractId="dummy" walletAddress="GABC" onSuccess={vi.fn()} />,
    );

    const percentInput = screen.getByPlaceholderText(/% \(0–100\)/i);
    fireEvent.change(percentInput, { target: { value: "101" } });
    fireEvent.blur(percentInput);

    expect(screen.getByText(/Percentage must be between 0 and 100/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Initialize contract/i })).toBeDisabled();
  });

  test("adds a second collaborator row when Add collaborator is clicked", () => {
    render(
      <InitializeForm contractId="dummy" walletAddress="GABC" onSuccess={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Add collaborator/i }));
    expect(screen.getAllByPlaceholderText(/Wallet address \(G\.\.\./i)).toHaveLength(2);
    expect(screen.getAllByPlaceholderText(/% \(0–100\)/i)).toHaveLength(2);
  });
});
