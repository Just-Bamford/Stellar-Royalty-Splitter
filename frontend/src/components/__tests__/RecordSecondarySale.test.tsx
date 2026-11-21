import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, beforeEach, it, expect, vi } from "vitest";

vi.mock("../../api", () => ({
  api: {
    recordSecondarySale: vi.fn(),
    confirmTransaction: vi.fn(),
  },
}));

vi.mock("../../stellar", () => ({
  signAndSubmitTransaction: vi.fn(),
}));

vi.mock("../../context/NetworkContext", () => ({
  useNetwork: vi.fn(() => ({ network: "testnet", networkMismatch: false })),
}));

import RecordSecondarySale from "../RecordSecondarySale";
import { api } from "../../api";
import { signAndSubmitTransaction } from "../../stellar";

describe("RecordSecondarySale", () => {
  const defaultProps = {
    contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    walletAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    royaltyRate: 500, // 5%
    onSuccess: vi.fn(),
  };

  const validGAddress1 = "G" + "B".repeat(55);
  const validGAddress2 = "G" + "C".repeat(55);
  const validCAddress = "C" + "D".repeat(55);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calculates royalty preview dynamically when salePrice is entered", async () => {
    render(<RecordSecondarySale {...defaultProps} />);

    const priceInput = screen.getByPlaceholderText("1000");
    fireEvent.change(priceInput, { target: { value: "10000" } });

    // 10000 * 500 / 10000 = 500
    expect(await screen.findByText("Royalty: 500")).toBeDefined();
  });

  it("clears calculatedRoyalty on submission error but preserves formData for retry (#1430)", async () => {
    vi.mocked(api.recordSecondarySale).mockRejectedValueOnce(
      new Error("Invalid sale price from blockchain"),
    );

    render(<RecordSecondarySale {...defaultProps} />);

    // Fill valid form
    fireEvent.change(screen.getByPlaceholderText("NFT identifier"), {
      target: { value: "nft-101" },
    });
    fireEvent.change(screen.getAllByPlaceholderText("G...")[0]!, {
      target: { value: validGAddress1 },
    });
    fireEvent.change(screen.getAllByPlaceholderText("G...")[1]!, {
      target: { value: validGAddress2 },
    });
    fireEvent.change(screen.getByPlaceholderText("1000"), {
      target: { value: "2000" },
    });
    fireEvent.change(screen.getByPlaceholderText("C..."), {
      target: { value: validCAddress },
    });

    // Check royalty is calculated before submit: 2000 * 500 / 10000 = 100
    expect(await screen.findByText("Royalty: 100")).toBeDefined();

    // Click submit
    const submitBtn = screen.getByRole("button", { name: "Record Sale" });
    fireEvent.click(submitBtn);

    // Wait for error status to appear
    expect(
      await screen.findByText(/Error: Invalid sale price from blockchain/i),
    ).toBeDefined();

    // Acceptance criteria 1: The royalty preview is cleared on error
    expect(document.querySelector(".calc-result")).toBeNull();

    // Acceptance criteria 2: Form data is preserved for retry
    expect((screen.getByPlaceholderText("NFT identifier") as HTMLInputElement).value).toBe("nft-101");
    expect((screen.getAllByPlaceholderText("G...")[0]! as HTMLInputElement).value).toBe(validGAddress1);
    expect((screen.getAllByPlaceholderText("G...")[1]! as HTMLInputElement).value).toBe(validGAddress2);
    expect((screen.getByPlaceholderText("1000") as HTMLInputElement).value).toBe("2000");
    expect((screen.getByPlaceholderText("C...") as HTMLInputElement).value).toBe(validCAddress);
  });

  it("resets form and clears calculatedRoyalty on successful submission", async () => {
    vi.mocked(api.recordSecondarySale).mockResolvedValueOnce({
      xdr: "AAAA...",
      royaltyAmount: 100,
    } as any);
    vi.mocked(signAndSubmitTransaction).mockResolvedValueOnce("tx-hash-123" as any);
    vi.mocked(api.confirmTransaction).mockResolvedValueOnce({} as any);

    render(<RecordSecondarySale {...defaultProps} />);

    fireEvent.change(screen.getByPlaceholderText("NFT identifier"), {
      target: { value: "nft-101" },
    });
    fireEvent.change(screen.getAllByPlaceholderText("G...")[0]!, {
      target: { value: validGAddress1 },
    });
    fireEvent.change(screen.getAllByPlaceholderText("G...")[1]!, {
      target: { value: validGAddress2 },
    });
    fireEvent.change(screen.getByPlaceholderText("1000"), {
      target: { value: "2000" },
    });
    fireEvent.change(screen.getByPlaceholderText("C..."), {
      target: { value: validCAddress },
    });

    const submitBtn = screen.getByRole("button", { name: "Record Sale" });
    fireEvent.click(submitBtn);

    expect(
      await screen.findByText(/Secondary sale recorded! Royalty: 100 tokens/i),
    ).toBeDefined();

    expect((screen.getByPlaceholderText("NFT identifier") as HTMLInputElement).value).toBe("");
    expect(document.querySelector(".calc-result")).toBeNull();
    expect(defaultProps.onSuccess).toHaveBeenCalled();
  });
});
