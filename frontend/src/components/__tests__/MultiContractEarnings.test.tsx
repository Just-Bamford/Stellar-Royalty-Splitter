import { render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom";
import { MultiContractEarnings } from "../MultiContractEarnings";
import * as SettingsContext from "../../context/SettingsContext";
import { api } from "../../api";

describe("MultiContractEarnings Loading Skeleton (#1379)", () => {
  const walletAddress = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(SettingsContext, "useSettings").mockReturnValue({
      settings: { displayCurrency: "USD" } as any,
      updateSettings: vi.fn(),
      resetSettings: vi.fn(),
    });
  });

  it("renders skeleton loader while fetching initial data", () => {
    // Return a promise that never resolves during the test
    vi.spyOn(api, "getMultiContractEarnings").mockReturnValue(new Promise(() => {}));

    render(<MultiContractEarnings walletAddress={walletAddress} />);

    expect(screen.getByTestId("mce-skeleton")).toBeInTheDocument();
    expect(screen.getByText("Multi-Contract Earnings")).toBeInTheDocument();
  });

  it("replaces skeleton loader with loaded data once resolved", async () => {
    vi.spyOn(api, "getMultiContractEarnings").mockResolvedValue({
      success: true,
      data: {
        summary: {
          totalEarned: 1250,
          contractCount: 3,
          totalPayouts: 15,
          avgPerContract: 416.67,
        },
        contracts: [
          {
            contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            earned: 800,
            share: 64.0,
            payoutCount: 10,
            lastPayout: new Date().toISOString(),
          },
        ],
      },
    } as any);

    render(<MultiContractEarnings walletAddress={walletAddress} />);

    await waitFor(() => {
      expect(screen.queryByTestId("mce-skeleton")).not.toBeInTheDocument();
      expect(screen.getAllByText("Total Earned").length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText("$1,250.00")).toBeInTheDocument();
    });
  });
});
