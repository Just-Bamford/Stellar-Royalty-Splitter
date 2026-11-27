import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom";

// #1389: a successful advance whose response has no `data` must not clear
// the displayed verification record.

const getVerification = vi.fn();
const advanceVerification = vi.fn();
const startVerification = vi.fn();

vi.mock("../api", () => ({
  api: {
    getVerification: (...args: unknown[]) => getVerification(...args),
    advanceVerification: (...args: unknown[]) => advanceVerification(...args),
    startVerification: (...args: unknown[]) => startVerification(...args),
  },
}));

import { ContributorVerification } from "./ContributorVerification";

const WALLET = "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW";

function record(step: string, status = "pending") {
  return {
    walletAddress: WALLET,
    step,
    status,
    adminNote: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
  };
}

async function renderAtEmailStep() {
  render(<ContributorVerification walletAddress={WALLET} isAdmin />);
  return screen.findByRole("button", { name: "Advance to KYC" });
}

describe("ContributorVerification advance (#1389)", () => {
  beforeEach(() => {
    getVerification.mockReset();
    advanceVerification.mockReset();
    startVerification.mockReset();
  });

  it("keeps the current record when the advance and the refetch return no data", async () => {
    getVerification
      .mockResolvedValueOnce({ success: true, data: record("email") })
      .mockResolvedValueOnce({ success: true });
    advanceVerification.mockResolvedValueOnce({ success: true });

    fireEvent.click(await renderAtEmailStep());

    await waitFor(() => expect(getVerification).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("button", { name: "Advance to KYC" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Start Verification/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("refetches the record when the advance response has no data", async () => {
    getVerification
      .mockResolvedValueOnce({ success: true, data: record("email") })
      .mockResolvedValueOnce({ success: true, data: record("kyc") });
    advanceVerification.mockResolvedValueOnce({ success: true });

    fireEvent.click(await renderAtEmailStep());

    expect(
      await screen.findByRole("button", { name: "Send to Manual Review" })
    ).toBeInTheDocument();
    expect(getVerification).toHaveBeenLastCalledWith(WALLET);
  });

  it("keeps the current record when the refetch fails", async () => {
    getVerification
      .mockResolvedValueOnce({ success: true, data: record("email") })
      .mockRejectedValueOnce(new Error("network"));
    advanceVerification.mockResolvedValueOnce({ success: true, data: undefined });

    fireEvent.click(await renderAtEmailStep());

    await waitFor(() => expect(getVerification).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("button", { name: "Advance to KYC" })).toBeInTheDocument();
  });

  it("uses the returned record without refetching when data is present", async () => {
    getVerification.mockResolvedValueOnce({ success: true, data: record("email") });
    advanceVerification.mockResolvedValueOnce({ success: true, data: record("kyc") });

    fireEvent.click(await renderAtEmailStep());

    expect(
      await screen.findByRole("button", { name: "Send to Manual Review" })
    ).toBeInTheDocument();
    expect(getVerification).toHaveBeenCalledTimes(1);
  });
});
