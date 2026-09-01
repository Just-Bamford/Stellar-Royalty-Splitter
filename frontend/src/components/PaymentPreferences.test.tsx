/**
 * Tests for optimistic payment-preference saves with offline-queue
 * awareness and rollback on failure (#771).
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, test, expect, vi, beforeEach, type Mock } from "vitest";
import "@testing-library/jest-dom";
import { PaymentPreferences } from "./PaymentPreferences";

vi.mock("../api", () => ({
  api: {
    getPaymentPreference: vi.fn(),
    savePaymentPreference: vi.fn(),
  },
}));

import { api } from "../api";

const mockGet = api.getPaymentPreference as Mock;
const mockSave = api.savePaymentPreference as Mock;

const WALLET = "GAPTAQKSMN2ILFVHXDE5V274BUPC6QCRMJZYJFNGW7ENT2X3BQOS4M3C";

describe("PaymentPreferences optimistic save (#771)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGet.mockResolvedValue({ paymentMethod: "direct_transfer" });
  });

  async function renderLoaded() {
    render(<PaymentPreferences walletAddress={WALLET} />);
    await waitFor(() => {
      expect(screen.getByRole("radio", { name: /direct transfer/i })).toHaveAttribute(
        "aria-checked",
        "true",
      );
    });
  }

  test("confirms the new selection on a normal successful save", async () => {
    mockSave.mockResolvedValue({ paymentMethod: "usdc" });
    await renderLoaded();

    fireEvent.click(screen.getByRole("radio", { name: /stablecoin/i }));
    fireEvent.click(screen.getByRole("button", { name: /save preference/i }));

    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent(/saved/i);
    });
    expect(screen.getByRole("radio", { name: /stablecoin/i })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  test("applies the choice optimistically before the request resolves", async () => {
    let resolveSave: (value: unknown) => void = () => {};
    mockSave.mockReturnValue(new Promise((resolve) => (resolveSave = resolve)));
    await renderLoaded();

    fireEvent.click(screen.getByRole("radio", { name: /stablecoin/i }));
    fireEvent.click(screen.getByRole("button", { name: /save preference/i }));

    // Optimistic: reflected immediately, before the network call settles.
    expect(screen.getByRole("radio", { name: /stablecoin/i })).toHaveAttribute(
      "aria-checked",
      "true",
    );

    resolveSave({ paymentMethod: "usdc" });
    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent(/saved/i);
    });
  });

  test("keeps the optimistic value and shows a pending message when the write is queued offline", async () => {
    mockSave.mockResolvedValue({ queued: true, offline: true });
    await renderLoaded();

    fireEvent.click(screen.getByRole("radio", { name: /stablecoin/i }));
    fireEvent.click(screen.getByRole("button", { name: /save preference/i }));

    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent(/offline.*sync automatically/i);
    });
    // Not rolled back — the choice is still applied pending the retry.
    expect(screen.getByRole("radio", { name: /stablecoin/i })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  test("rolls back the optimistic value when the offline queue is full", async () => {
    mockSave.mockResolvedValue({
      queued: false,
      offline: true,
      message: "Offline queue is full (max 100 pending writes). Please retry once back online.",
    });
    await renderLoaded();

    fireEvent.click(screen.getByRole("radio", { name: /stablecoin/i }));
    fireEvent.click(screen.getByRole("button", { name: /save preference/i }));

    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent(/queue is full/i);
    });
    // The confirmed value reverted to the prior selection, so the form is
    // dirty again (the still-highlighted pending choice differs from it)
    // and the Revert control reappears — proof the optimistic apply was
    // rolled back rather than left half-committed.
    expect(screen.getByRole("button", { name: /revert/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /save preference/i })).toBeEnabled();
  });

  test("rolls back the optimistic value on a hard failure", async () => {
    mockSave.mockRejectedValue(new Error("Request failed (500)"));
    await renderLoaded();

    fireEvent.click(screen.getByRole("radio", { name: /stablecoin/i }));
    fireEvent.click(screen.getByRole("button", { name: /save preference/i }));

    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent(/request failed/i);
    });
    expect(screen.getByRole("button", { name: /revert/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /save preference/i })).toBeEnabled();
  });
});
