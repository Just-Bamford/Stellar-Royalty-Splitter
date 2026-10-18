import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, test, expect, vi, beforeEach, type Mock } from "vitest";
import "@testing-library/jest-dom";
import { FeatureFlagManager } from "./FeatureFlagManager";

vi.mock("../api", () => ({
  api: {
    listFeatureFlags: vi.fn(),
    getFeatureFlagMetrics: vi.fn(),
    getFeatureFlagHistory: vi.fn(),
    createFeatureFlag: vi.fn(),
    updateFeatureFlag: vi.fn(),
    rollbackFeatureFlag: vi.fn(),
    setFeatureFlagRollout: vi.fn(),
    addFeatureFlagRule: vi.fn(),
    removeFeatureFlagRule: vi.fn(),
    monitorFeatureFlag: vi.fn(),
  },
}));

import { api } from "../api";

const mockList = api.listFeatureFlags as Mock;
const mockCreate = api.createFeatureFlag as Mock;
const mockUpdate = api.updateFeatureFlag as Mock;
const mockRollback = api.rollbackFeatureFlag as Mock;
const mockRollout = api.setFeatureFlagRollout as Mock;
const mockAddRule = api.addFeatureFlagRule as Mock;
const mockMetrics = api.getFeatureFlagMetrics as Mock;
const mockHistory = api.getFeatureFlagHistory as Mock;

const FLAG = {
  id: 1,
  name: "checkout-v2",
  description: "New checkout",
  enabled: true,
  killed: false,
  archived: false,
  rolloutPercentage: 25,
  createdBy: "admin",
  createdAt: "2026-09-30T00:00:00.000Z",
  updatedAt: "2026-09-30T00:00:00.000Z",
  rules: [
    {
      id: 9,
      flagId: 1,
      ruleType: "user" as const,
      value: "GUSER",
      enabled: true,
      createdAt: "2026-09-30T00:00:00.000Z",
    },
  ],
};

const HEALTH = {
  flag: "checkout-v2",
  healthy: true,
  reasons: [],
  thresholds: { maxErrorRate: 0.05, maxP95LatencyMs: 1000, windowMs: 3600000 },
  metrics: {
    flag: "checkout-v2",
    windowMs: 3600000,
    requests: 10,
    errors: 1,
    errorRate: 0.1,
    sampleCount: 11,
    avgLatencyMs: 120,
    p95LatencyMs: 300,
    maxLatencyMs: 400,
  },
};

describe("FeatureFlagManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockList.mockResolvedValue({ flags: [FLAG] });
    mockCreate.mockResolvedValue(FLAG);
    mockUpdate.mockResolvedValue({ ...FLAG, enabled: false });
    mockRollback.mockResolvedValue({ ...FLAG, killed: true });
    mockRollout.mockResolvedValue({ ...FLAG, rolloutPercentage: 50 });
    mockAddRule.mockResolvedValue(FLAG.rules[0]);
    mockMetrics.mockResolvedValue(HEALTH);
    mockHistory.mockResolvedValue({
      flag: "checkout-v2",
      history: [
        {
          id: 1,
          flagId: 1,
          flagName: "checkout-v2",
          action: "create",
          changedBy: "admin",
          oldValue: null,
          newValue: null,
          reason: null,
          timestamp: "2026-09-30T00:00:00.000Z",
        },
      ],
    });
  });

  test("renders flags loaded from the API", async () => {
    render(<FeatureFlagManager />);
    expect(await screen.findByText("checkout-v2")).toBeInTheDocument();
    expect(screen.getByText(/rollout: 25%/i)).toBeInTheDocument();
    expect(screen.getByText(/1 rule/i)).toBeInTheDocument();
  });

  test("toggles a flag", async () => {
    render(<FeatureFlagManager />);
    fireEvent.click(await screen.findByRole("button", { name: /toggle checkout-v2/i }));

    await waitFor(() => {
      expect(mockUpdate).toHaveBeenCalledWith("checkout-v2", { enabled: false });
    });
  });

  test("creates a flag", async () => {
    render(<FeatureFlagManager />);
    await screen.findByText("checkout-v2");

    fireEvent.change(screen.getByLabelText(/^name$/i), { target: { value: "beta" } });
    fireEvent.click(screen.getByRole("button", { name: /create flag/i }));

    await waitFor(() => {
      expect(mockCreate).toHaveBeenCalledWith({ name: "beta", description: null });
    });
  });

  test("rolls back a flag", async () => {
    render(<FeatureFlagManager />);
    fireEvent.click(await screen.findByRole("button", { name: /rollback checkout-v2/i }));

    await waitFor(() => {
      expect(mockRollback).toHaveBeenCalledWith("checkout-v2", "Manual rollback");
    });
  });

  test("updates rollout percentage on blur", async () => {
    render(<FeatureFlagManager />);
    const input = await screen.findByLabelText(/rollout percentage for checkout-v2/i);
    fireEvent.change(input, { target: { value: "50" } });
    fireEvent.blur(input);

    await waitFor(() => {
      expect(mockRollout).toHaveBeenCalledWith("checkout-v2", 50);
    });
  });

  test("shows metrics and history in the details panel", async () => {
    render(<FeatureFlagManager />);
    fireEvent.click(await screen.findByRole("button", { name: /details for checkout-v2/i }));

    expect(await screen.findByText(/rollout health/i)).toBeInTheDocument();
    expect(screen.getByText(/p95 latency: 300 ms/i)).toBeInTheDocument();
    expect(screen.getByText(/history/i)).toBeInTheDocument();
  });

  test("adds a targeting rule", async () => {
    render(<FeatureFlagManager />);
    fireEvent.click(await screen.findByRole("button", { name: /details for checkout-v2/i }));
    await screen.findByText(/targeting rules/i);

    fireEvent.change(screen.getByLabelText(/rule value for checkout-v2/i), {
      target: { value: "GORG" },
    });
    fireEvent.click(screen.getByRole("button", { name: /add rule/i }));

    await waitFor(() => {
      expect(mockAddRule).toHaveBeenCalledWith("checkout-v2", {
        ruleType: "user",
        value: "GORG",
        enabled: true,
      });
    });
  });
});
