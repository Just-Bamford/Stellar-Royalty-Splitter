/**
 * Tests for the ImpactDashboard component (#1064).
 *
 * Covers: personal + project stats, emissions chart, offset purchase,
 * auto-offset settings, project contributions, social share links.
 *
 * Run with: cd frontend && npx vitest run src/components/ImpactDashboard.test.tsx
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { vi, type Mock } from "vitest";
import "@testing-library/jest-dom";
import { ImpactDashboard } from "./ImpactDashboard";

vi.mock("../api", () => ({
  api: {
    getCarbonFootprint: vi.fn(),
    getCarbonProject: vi.fn(),
    purchaseCarbonOffsets: vi.fn(),
    getCarbonOffsets: vi.fn(),
    getCarbonSettings: vi.fn(),
    saveCarbonSettings: vi.fn(),
    getCarbonProjects: vi.fn(),
    getCarbonShare: vi.fn(),
  },
}));

import { api } from "../api";

const mockGetCarbonFootprint = api.getCarbonFootprint as Mock;
const mockGetCarbonProject = api.getCarbonProject as Mock;
const mockPurchaseCarbonOffsets = api.purchaseCarbonOffsets as Mock;
const mockGetCarbonOffsets = api.getCarbonOffsets as Mock;
const mockGetCarbonSettings = api.getCarbonSettings as Mock;
const mockSaveCarbonSettings = api.saveCarbonSettings as Mock;
const mockGetCarbonProjects = api.getCarbonProjects as Mock;
const mockGetCarbonShare = api.getCarbonShare as Mock;

const CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const WALLET = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const mockFootprint = {
  walletAddress: WALLET,
  txCount: 10,
  totalGrams: 1000,
  totalKg: 1,
  offsetGrams: 250,
  offsetTonnes: 0.00025,
  offsetPurchases: 1,
  offsetUsdCents: 1,
  netGrams: 750,
  offsetCoveragePercent: 25,
  byDay: [{ date: "2026-01-01", txCount: 10, grams: 1000 }],
};

const mockProject = {
  contractId: CONTRACT,
  txCount: 20,
  totalGrams: 2000,
  totalKg: 2,
  contributorCount: 3,
  offsetTonnes: 0.001,
  offsetPurchases: 2,
  offsetContributors: 2,
  byDay: [{ date: "2026-01-01", txCount: 20, grams: 2000 }],
};

const mockProjects = [
  {
    id: "amazon-reforestation",
    name: "Amazon Reforestation Collective",
    type: "forest",
    location: "Brazil",
    description: "Native-species reforestation.",
  },
  {
    id: "pacific-blue-carbon",
    name: "Pacific Blue Carbon",
    type: "ocean",
    location: "Fiji",
    description: "Mangrove restoration.",
  },
];

const mockShare = {
  text: "My Stellar royalty footprint",
  stats: { totalKg: 1, txCount: 10, offsetCoveragePercent: 25, netGrams: 750 },
  shareUrls: {
    x: "https://twitter.com/intent/tweet?text=hi",
    facebook: "https://www.facebook.com/sharer/sharer.php?u=hi",
    linkedin: "https://www.linkedin.com/sharing/share-offsite/?url=hi",
  },
};

function setup() {
  mockGetCarbonFootprint.mockResolvedValue({ success: true, data: mockFootprint });
  mockGetCarbonProject.mockResolvedValue({ success: true, data: mockProject });
  mockGetCarbonOffsets.mockResolvedValue({
    success: true,
    data: [],
    pagination: { total: 0, limit: 20, offset: 0 },
  });
  mockGetCarbonSettings.mockResolvedValue({
    success: true,
    data: { walletAddress: WALLET, autoOffsetEnabled: false, offsetPercentage: 1 },
  });
  mockGetCarbonProjects.mockResolvedValue({ success: true, data: mockProjects });
  mockGetCarbonShare.mockResolvedValue({ success: true, data: mockShare });
  render(<ImpactDashboard contractId={CONTRACT} walletAddress={WALLET} />);
}

describe("ImpactDashboard", () => {
  beforeEach(() => vi.clearAllMocks());

  test("shows personal footprint progress", async () => {
    setup();

    await waitFor(() => expect(screen.getByText("Environmental Impact")).toBeInTheDocument());
    expect(screen.getByText("Your footprint")).toBeInTheDocument();
    expect(screen.getByText("1.000 kg")).toBeInTheDocument();
    expect(screen.getByText("25%")).toBeInTheDocument();
  });

  test("shows project-wide impact", async () => {
    setup();

    await waitFor(() => expect(screen.getByText("Project-wide impact")).toBeInTheDocument());
    expect(screen.getByText("2.000 kg")).toBeInTheDocument();
  });

  test("lists forest and ocean projects", async () => {
    setup();

    await waitFor(() =>
      expect(screen.getAllByText("Amazon Reforestation Collective").length).toBeGreaterThan(0),
    );
    expect(screen.getAllByText("Pacific Blue Carbon").length).toBeGreaterThan(0);
  });

  test("purchases offsets from the form", async () => {
    setup();
    mockPurchaseCarbonOffsets.mockResolvedValue({
      success: true,
      data: { offsetId: 1, tonnes: 0.01, project: "mixed", status: "completed" },
    });

    await waitFor(() => expect(screen.getByLabelText("Tonnes of CO2e to offset")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Tonnes of CO2e to offset"), { target: { value: "0.02" } });
    fireEvent.click(screen.getByRole("button", { name: "Purchase" }));

    await waitFor(() =>
      expect(mockPurchaseCarbonOffsets).toHaveBeenCalledWith(
        expect.objectContaining({ walletAddress: WALLET, tonnes: 0.02 }),
      ),
    );
  });

  test("saves auto-offset settings", async () => {
    setup();
    mockSaveCarbonSettings.mockResolvedValue({ success: true, data: {} });

    await waitFor(() =>
      expect(screen.getByLabelText("Percentage of earnings to auto-offset")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByLabelText("Auto-offset"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(mockSaveCarbonSettings).toHaveBeenCalledWith(WALLET, {
        autoOffsetEnabled: true,
        offsetPercentage: 1,
      }),
    );
  });

  test("renders social share links", async () => {
    setup();

    await waitFor(() => expect(screen.getByText("Share your impact")).toBeInTheDocument());
    expect(screen.getByText("Share on X")).toHaveAttribute(
      "href",
      expect.stringContaining("twitter.com/intent/tweet"),
    );
    expect(screen.getByText("Share on Facebook")).toBeInTheDocument();
    expect(screen.getByText("Share on LinkedIn")).toBeInTheDocument();
  });
});
