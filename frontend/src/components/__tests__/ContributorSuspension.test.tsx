import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom";
import { ContributorSuspension } from "../ContributorSuspension";
import { api } from "../../api";

describe("ContributorSuspension Address Validation (#1346)", () => {
  const contractId = "CB1111111111111111111111111111111111111111111111111111111111";
  const walletAddress = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
  const validAddress = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(api, "getContributorStatuses").mockResolvedValue({
      data: [],
    } as any);
    vi.spyOn(api, "setContributorStatus").mockResolvedValue({
      success: true,
    } as any);
  });

  it("shows inline error when submitting with an invalid address and does not call API", async () => {
    render(<ContributorSuspension contractId={contractId} walletAddress={walletAddress} />);

    await waitFor(() => {
      expect(screen.getByText("Current Statuses")).toBeInTheDocument();
    });

    const addressInput = screen.getByLabelText(/Contributor Address/i);
    fireEvent.change(addressInput, { target: { value: "GINVALID123" } });

    const submitBtn = screen.getByRole("button", { name: /Update Status/i });
    const form = submitBtn.closest("form")!;
    fireEvent.submit(form);

    expect(
      screen.getByText("Please enter a valid Stellar address (starts with G, 56 characters)")
    ).toBeInTheDocument();
    expect(api.setContributorStatus).not.toHaveBeenCalled();
  });

  it("proceeds with API call when submitting with a valid 56-char G-address", async () => {
    render(<ContributorSuspension contractId={contractId} walletAddress={walletAddress} />);

    await waitFor(() => {
      expect(screen.getByText("Current Statuses")).toBeInTheDocument();
    });

    const addressInput = screen.getByLabelText(/Contributor Address/i);
    fireEvent.change(addressInput, { target: { value: validAddress } });

    const submitBtn = screen.getByRole("button", { name: /Update Status/i });
    const form = submitBtn.closest("form")!;
    fireEvent.submit(form);

    await waitFor(() => {
      expect(api.setContributorStatus).toHaveBeenCalledWith(
        contractId,
        validAddress,
        expect.objectContaining({
          status: "suspended",
        })
      );
    });
  });
});
