import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { SettingsProvider } from "../context/SettingsContext";
import { MultiContractEarnings } from "./MultiContractEarnings";

describe("MultiContractEarnings", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reserves the summary and breakdown while the first earnings request is pending", async () => {
    let finishRequest!: (response: Awaited<ReturnType<typeof api.getMultiContractEarnings>>) => void;
    const request = new Promise<Awaited<ReturnType<typeof api.getMultiContractEarnings>>>((resolve) => {
      finishRequest = resolve;
    });
    vi.spyOn(api, "getMultiContractEarnings").mockReturnValue(request);

    const { container } = render(
      <SettingsProvider>
        <MultiContractEarnings walletAddress={"G" + "A".repeat(55)} />
      </SettingsProvider>,
    );

    const heading = screen.getByRole("heading", { name: "Multi-Contract Earnings" });
    expect(screen.getByRole("status")).toHaveTextContent("Loading earnings");
    expect(container.querySelectorAll(".mce-kpi .skeleton-loader")).toHaveLength(4);
    expect(container.querySelector(".mce-breakdown.skeleton-loader")).toBeInTheDocument();

    await act(async () => {
      finishRequest({
        data: {
          summary: { totalEarned: 0, contractCount: 0, totalPayouts: 0, avgPerContract: 0 },
          contracts: [],
        },
      });
    });

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Multi-Contract Earnings" })).toBe(heading);
    expect(container.querySelectorAll(".mce-kpi")).toHaveLength(4);
    expect(screen.getByText("No earnings found for this period.")).toHaveClass("mce-breakdown");
  });
});
