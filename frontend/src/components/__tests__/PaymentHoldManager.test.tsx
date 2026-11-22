import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom";
import { PaymentHoldManager } from "../PaymentHoldManager";
import { api } from "../../api";

vi.mock("../../api", () => ({
  api: {
    getHeldTransactions: vi.fn(),
    approveHoldRelease: vi.fn(),
    releasePaymentHold: vi.fn(),
  },
}));

describe("PaymentHoldManager Component (#1344)", () => {
  const mockTxns = [
    {
      id: 101,
      txHash: "0xabc123",
      contractId: "C123",
      type: "distribute",
      initiatorAddress: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
      requestedAmount: "500",
      tokenId: "USDC",
      status: "held",
      hold_reason: "Compliance review",
      hold_until: "2026-12-31T00:00:00.000Z",
      hold_placed_at: "2026-11-20T00:00:00.000Z",
      hold_placed_by: "GADMIN",
      hold_released_at: null,
      hold_released_by: null,
      hold_approved_by: null,
      hold_approved_at: null,
      hold_approval_note: null,
      hold_status: "active",
      timestamp: "2026-11-20T00:00:00.000Z",
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getHeldTransactions).mockResolvedValue({ data: mockTxns } as any);
    vi.mocked(api.approveHoldRelease).mockResolvedValue({ success: true } as any);
    vi.mocked(api.releasePaymentHold).mockResolvedValue({ success: true } as any);
  });

  it("renders non-admin notice when isAdmin is false", () => {
    render(<PaymentHoldManager contractId="C123" isAdmin={false} />);
    expect(screen.getByText("Admin access required to manage payment holds.")).toBeInTheDocument();
  });

  it("loads and displays held transactions when isAdmin is true", async () => {
    render(<PaymentHoldManager contractId="C123" isAdmin={true} />);

    await waitFor(() => {
      expect(screen.getByText("Compliance review")).toBeInTheDocument();
      expect(screen.getByText("500")).toBeInTheDocument();
    });

    expect(api.getHeldTransactions).toHaveBeenCalledWith("C123", "active");
  });

  it("executes two-step release successfully when both API calls succeed", async () => {
    render(
      <PaymentHoldManager
        contractId="C123"
        isAdmin={true}
        walletAddress="GADMIN123"
      />
    );

    await waitFor(() => {
      expect(screen.getByText("Approve & Release")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Approve & Release"));

    expect(screen.getByText("Release Payment Hold")).toBeInTheDocument();

    const noteInput = screen.getByPlaceholderText("Add a note about this release...");
    fireEvent.change(noteInput, { target: { value: "Verified compliance docs" } });

    fireEvent.click(screen.getByRole("button", { name: "Confirm Release" }));

    await waitFor(() => {
      expect(api.approveHoldRelease).toHaveBeenCalledWith(101, "GADMIN123", "Verified compliance docs");
      expect(api.releasePaymentHold).toHaveBeenCalledWith(101, "GADMIN123", "Verified compliance docs");
    });
  });

  it("handles step 1 approval failure and does not call releasePaymentHold", async () => {
    vi.mocked(api.approveHoldRelease).mockRejectedValueOnce(new Error("Unauthorized approver"));

    render(
      <PaymentHoldManager
        contractId="C123"
        isAdmin={true}
        walletAddress="GADMIN123"
      />
    );

    await waitFor(() => {
      expect(screen.getByText("Approve & Release")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Approve & Release"));
    fireEvent.click(screen.getByRole("button", { name: "Confirm Release" }));

    await waitFor(() => {
      expect(screen.getAllByText("Approval failed: Unauthorized approver").length).toBeGreaterThanOrEqual(1);
    });

    expect(api.approveHoldRelease).toHaveBeenCalledTimes(1);
    expect(api.releasePaymentHold).not.toHaveBeenCalled();
  });

  it("handles step 2 release failure after approval and informs user of approved state", async () => {
    vi.mocked(api.releasePaymentHold).mockRejectedValueOnce(new Error("Horizon network timeout"));

    render(
      <PaymentHoldManager
        contractId="C123"
        isAdmin={true}
        walletAddress="GADMIN123"
      />
    );

    await waitFor(() => {
      expect(screen.getByText("Approve & Release")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Approve & Release"));
    fireEvent.click(screen.getByRole("button", { name: "Confirm Release" }));

    await waitFor(() => {
      expect(
        screen.getAllByText("Hold was approved but release failed. Please try releasing manually.").length
      ).toBeGreaterThanOrEqual(1);
    });

    expect(api.approveHoldRelease).toHaveBeenCalledTimes(1);
    expect(api.releasePaymentHold).toHaveBeenCalledTimes(1);
  });
});
