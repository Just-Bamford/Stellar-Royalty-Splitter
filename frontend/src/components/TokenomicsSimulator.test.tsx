import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import {
  TokenomicsSimulator,
  sumAllocations,
  validateAllocations,
  buildScenarioAllocations,
  buildSupplyCsv,
  buildUnlockEventsCsv,
  formatTokenAmount,
  type AllocationInput,
} from "./TokenomicsSimulator";

const mockModel = {
  totalSupply: 1000,
  current: { circulatingSupply: 100, lockedSupply: 900, circulatingPercent: 10 },
  dilution: { horizonMonths: 36, dilutionPercent: 50, newlyUnlocked: 400 },
  projection: {
    points: [
      {
        date: "2025-01-01T00:00:00.000Z",
        totalSupply: 1000,
        circulatingSupply: 100,
        lockedSupply: 900,
        circulatingPercent: 10,
      },
    ],
  },
  unlockEvents: [],
};

const { getTokenEconomicsModel } = vi.hoisted(() => ({
  getTokenEconomicsModel: vi.fn(),
}));

vi.mock("../api", () => ({
  api: {
    getTokenEconomicsModel,
    simulateTokenDistribution: vi.fn(),
    getVestingAnalytics: vi.fn(),
    simulateVestingSchedule: vi.fn(),
  },
}));

const allocations: AllocationInput[] = [
  { name: "Team", amount: 600, tgePercent: 0, cliffMonths: 12, vestingMonths: 36 },
  { name: "Community", amount: 400, tgePercent: 10, cliffMonths: 0, vestingMonths: 48 },
];

describe("TokenomicsSimulator helpers", () => {
  it("sums allocation amounts", () => {
    expect(sumAllocations(allocations)).toBe(1000);
  });

  it("validates allocations against total supply", () => {
    expect(validateAllocations(allocations, 1000)).toBeNull();
    expect(validateAllocations(allocations, 500)).toMatch(/exceed total supply/);
    expect(validateAllocations([], 1000)).toMatch(/at least one allocation/);
    expect(validateAllocations(allocations, 0)).toMatch(/positive number/);
  });

  it("builds scenarios by shifting parameters and clamping", () => {
    const scenario = buildScenarioAllocations(allocations, {
      tgeDelta: 20,
      cliffDelta: -6,
      vestingDelta: -100,
    });
    expect(scenario[0].tgePercent).toBe(20);
    expect(scenario[0].cliffMonths).toBe(6);
    expect(scenario[0].vestingMonths).toBe(0);
    expect(scenario[1].tgePercent).toBe(30);
  });

  it("builds an RFC 4180 supply CSV", () => {
    const csv = buildSupplyCsv(mockModel.projection.points);
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe(
      "Date,Total Supply,Circulating Supply,Locked Supply,Circulating %",
    );
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("1000,100,900,10");
  });

  it("builds an unlock events CSV", () => {
    const csv = buildUnlockEventsCsv([
      {
        date: "2025-07-01T00:00:00.000Z",
        month: 6,
        unlockedAmount: 200,
        circulatingSupply: 300,
        circulatingPercent: 30,
      },
    ]);
    expect(csv.split("\r\n")).toHaveLength(2);
    expect(csv).toContain("200,300,30");
  });

  it("formats token amounts safely", () => {
    expect(formatTokenAmount(Number.NaN)).toBe("0");
    expect(formatTokenAmount(1000)).toMatch(/1.000/);
  });
});

describe("TokenomicsSimulator", () => {
  beforeEach(() => {
    getTokenEconomicsModel.mockReset();
    getTokenEconomicsModel.mockResolvedValue({ success: true, data: mockModel });
  });

  it("renders the dashboard once the model loads", async () => {
    render(<TokenomicsSimulator />);
    expect(screen.getByTestId("tokenomics-simulator")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId("supply-projection")).toBeInTheDocument(),
    );
    expect(getTokenEconomicsModel).toHaveBeenCalled();
  });
});
