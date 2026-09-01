import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { vi, type Mock } from "vitest";
import "@testing-library/jest-dom";
import { EarningsDashboard, distributionAmount } from "./EarningsDashboard";

// Mock the API module
vi.mock("../api", () => ({
  api: {
    getAnalytics: vi.fn(),
    getCollaborators: vi.fn(),
    getRoyaltyStats: vi.fn(),
    getTransactionHistory: vi.fn(),
    getSecondarySales: vi.fn(),
  },
}));

import { api } from "../api";

vi.mock("../context/SettingsContext", () => ({
  useSettings: vi.fn(() => ({
    settings: { displayCurrency: "XLM", trackedContracts: [] },
    updateSettings: vi.fn(),
  })),
}));

import { useSettings } from "../context/SettingsContext";
import { useAnalytics } from "../hooks/queries/useAnalytics";
import { useCollaborators } from "../hooks/queries/useCollaborators";
import { useRoyaltyStats } from "../hooks/queries/useRoyaltyStats";
import { useTransactionHistory } from "../hooks/queries/useTransactionHistory";
import { useSecondarySales } from "../hooks/queries/useSecondarySales";

vi.mock("../hooks/queries/useAnalytics");
vi.mock("../hooks/queries/useCollaborators");
vi.mock("../hooks/queries/useRoyaltyStats");
vi.mock("../hooks/queries/useTransactionHistory");
vi.mock("../hooks/queries/useSecondarySales");

vi.mock("../utils/dashboardExport", async () => {
  const actual = await vi.importActual<typeof import("../utils/dashboardExport")>(
    "../utils/dashboardExport",
  );
  return {
    ...actual,
    exportElementToPDF: vi.fn().mockResolvedValue(undefined),
    downloadDashboardCSV: vi.fn(),
    downloadDashboardJSON: vi.fn(),
  };
});

import {
  exportElementToPDF,
  downloadDashboardCSV,
  downloadDashboardJSON,
} from "../utils/dashboardExport";

const mockUseSettings = useSettings as Mock;

function setTrackedContracts(contracts: string[]) {
  mockUseSettings.mockReturnValue({
    settings: { displayCurrency: "XLM", trackedContracts: contracts },
    updateSettings: vi.fn(),
  });
}

const mockGetAnalytics = api.getAnalytics as Mock;
const mockGetCollaborators = api.getCollaborators as Mock;
const mockGetRoyaltyStats = api.getRoyaltyStats as Mock;
const mockGetTransactionHistory = api.getTransactionHistory as Mock;
const mockGetSecondarySales = api.getSecondarySales as Mock;
const mockUseAnalytics = useAnalytics as Mock;
const mockUseCollaborators = useCollaborators as Mock;
const mockUseRoyaltyStats = useRoyaltyStats as Mock;
const mockUseTransactionHistory = useTransactionHistory as Mock;
const mockUseSecondarySales = useSecondarySales as Mock;

const MOCK_CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const MOCK_WALLET = "GAPTAQKSMN2ILFVHXDE5V274BUPC6QCRMJZYJFNGW7ENT2X3BQOS4M3C";
const MOCK_COLLAB1 = "GA7E6YDRQKJ2JNOG27UPSCQ3FQ6U4X3QQGJKHNGF23T7QCI2FM6E3W2P";

const mockCollaborators = [
  { address: MOCK_WALLET, basisPoints: 6000 },
  { address: MOCK_COLLAB1, basisPoints: 4000 },
];

const mockAnalyticsData = {
  success: true,
  data: {
    totalDistributed: 1000,
    primaryRoyaltiesTotal: 700,
    secondaryRoyaltiesTotal: 300,
    collaboratorStats: [
      { address: MOCK_WALLET, totalEarned: 600, payoutCount: 3 },
      { address: MOCK_COLLAB1, totalEarned: 400, payoutCount: 2 },
    ],
  },
};

const mockTransactionHistory = {
  success: true,
  data: [
    {
      id: 1,
      type: "distribute",
      requestedAmount: "500",
      timestamp: "2026-08-01T12:00:00Z",
      status: "confirmed",
      txHash: "hash123456789",
    },
  ],
};

const mockSecondarySales = {
  sales: [
    {
      id: 1,
      nftId: "nft-101",
      royaltyAmount: "300",
      timestamp: "2026-08-01T14:00:00Z",
      transactionHash: "salehash98765",
    },
  ],
};

function queryResult(data: unknown, overrides: Record<string, unknown> = {}) {
  return {
    data,
    isLoading: false,
    isError: false,
    error: null,
    isFetching: false,
    refetch: vi.fn(),
    ...overrides,
  };
}

function mockDashboardHooks({
  analytics = mockAnalyticsData,
  collaborators = mockCollaborators,
  royaltyStats = { totalRoyaltiesGenerated: "300" },
  transactions = mockTransactionHistory,
  secondarySales = mockSecondarySales,
  overrides = {},
}: {
  analytics?: unknown;
  collaborators?: unknown;
  royaltyStats?: unknown;
  transactions?: unknown;
  secondarySales?: unknown;
  overrides?: Record<string, Record<string, unknown>>;
} = {}) {
  mockUseAnalytics.mockReturnValue(queryResult(analytics, overrides.analytics));
  mockUseCollaborators.mockReturnValue(queryResult(collaborators, overrides.collaborators));
  mockUseRoyaltyStats.mockReturnValue(queryResult(royaltyStats, overrides.royaltyStats));
  mockUseTransactionHistory.mockReturnValue(queryResult(transactions, overrides.transactions));
  mockUseSecondarySales.mockReturnValue(queryResult(secondarySales, overrides.secondarySales));
}

describe("live distribution updates (#890)", () => {
  it("extracts the amount from supported distribution event payloads", () => {
    expect(distributionAmount({
      type: "distribution_completed",
      contractId: MOCK_CONTRACT,
      transactionId: 1,
      timestamp: "2026-08-29T12:00:00Z",
      requestedAmount: "125.5",
    })).toBe(125.5);
    expect(distributionAmount({
      type: "secondary_distribution_completed",
      contractId: MOCK_CONTRACT,
      transactionId: 2,
      timestamp: "2026-08-29T12:00:00Z",
      totalRoyalties: "42",
    })).toBe(42);
  });

  it("ignores malformed or non-positive amounts", () => {
    const event = {
      type: "distribution_completed" as const,
      contractId: MOCK_CONTRACT,
      transactionId: 3,
      timestamp: "2026-08-29T12:00:00Z",
      requestedAmount: "not-a-number",
    };
    expect(distributionAmount(event)).toBeNull();
    expect(distributionAmount({ ...event, requestedAmount: "0" })).toBeNull();
  });
});

describe("EarningsDashboard Component", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setTrackedContracts([]);
    mockDashboardHooks();
  });

  it("renders empty state when contractId is not provided", () => {
    render(<EarningsDashboard contractId="" />);
    expect(screen.getByTestId("earnings-dashboard-empty")).toBeInTheDocument();
    expect(screen.getByText(/Please select or initialize a contract/i)).toBeInTheDocument();
  });

  it("renders loading skeleton initially when contractId is provided", () => {
    mockDashboardHooks({
      analytics: undefined,
      collaborators: undefined,
      royaltyStats: undefined,
      transactions: undefined,
      secondarySales: undefined,
      overrides: {
        analytics: { isLoading: true },
        collaborators: { isLoading: true },
        royaltyStats: { isLoading: true },
        transactions: { isLoading: true },
        secondarySales: { isLoading: true },
      },
    });

    render(<EarningsDashboard contractId={MOCK_CONTRACT} />);
    expect(screen.getByTestId("earnings-dashboard-loading")).toBeInTheDocument();
  });

  it("renders dashboard with KPIs, collaborators, and payouts after data loads", async () => {
    render(<EarningsDashboard contractId={MOCK_CONTRACT} walletAddress={MOCK_WALLET} />);

    await waitFor(() => {
      expect(screen.getByTestId("earnings-dashboard")).toBeInTheDocument();
    });

    expect(screen.getByText("Collaborator Earnings Dashboard")).toBeInTheDocument();

    // Verify KPI Values exist
    expect(screen.getByText("Total Distributed")).toBeInTheDocument();
    expect(screen.getByText("Primary Royalties")).toBeInTheDocument();
    expect(screen.getByText("Secondary Royalties")).toBeInTheDocument();

    // Verify Collaborator rows
    expect(screen.getByText("You")).toBeInTheDocument(); // Badge for connected wallet
    expect(screen.getByText("60.00%")).toBeInTheDocument();
    expect(screen.getByText("40.00%")).toBeInTheDocument();

    // Verify Advanced Analytics Dashboard is rendered
    expect(screen.getByTestId("advanced-analytics-dashboard")).toBeInTheDocument();
  });

  it("filters collaborators by search query", async () => {
    mockDashboardHooks({
      royaltyStats: {},
      transactions: { data: [] },
      secondarySales: { sales: [] },
    });

    render(<EarningsDashboard contractId={MOCK_CONTRACT} walletAddress={MOCK_WALLET} />);

    await waitFor(() => {
      expect(screen.getByTestId("earnings-dashboard")).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText(/Search by address/i);
    fireEvent.change(searchInput, { target: { value: MOCK_COLLAB1.slice(0, 8) } });

    expect(screen.getByText(/40.00%/)).toBeInTheDocument();
    expect(screen.queryByText("You")).not.toBeInTheDocument();
  });

  it("filters recent payouts using tab buttons", async () => {
    mockDashboardHooks({ royaltyStats: {} });

    render(<EarningsDashboard contractId={MOCK_CONTRACT} walletAddress={MOCK_WALLET} />);

    await waitFor(() => {
      expect(screen.getByTestId("earnings-dashboard")).toBeInTheDocument();
    });

    const primaryTab = screen.getByRole("tab", { name: "Primary" });
    fireEvent.click(primaryTab);

    expect(screen.getByText("Primary Royalty Distribution")).toBeInTheDocument();
    expect(screen.queryByText(/NFT Resale/i)).not.toBeInTheDocument();
  });

  it("renders error state when API fails", async () => {
    mockDashboardHooks({
      analytics: undefined,
      collaborators: undefined,
      overrides: {
        analytics: { isError: true, error: new Error("Network Error") },
        collaborators: { isError: true, error: new Error("Network Error") },
      },
    });

    render(<EarningsDashboard contractId={MOCK_CONTRACT} />);

    await waitFor(() => {
      expect(screen.getByTestId("earnings-dashboard-error")).toBeInTheDocument();
    });

    expect(screen.getByText(/Error Loading Dashboard/i)).toBeInTheDocument();
  });

  describe("dashboard export (#770)", () => {
    beforeEach(() => {
      mockDashboardHooks();
    });

    async function renderLoaded() {
      render(<EarningsDashboard contractId={MOCK_CONTRACT} walletAddress={MOCK_WALLET} />);
      await waitFor(() => {
        expect(screen.getByTestId("earnings-dashboard")).toBeInTheDocument();
      });
    }

    it("opens the export menu with PDF, CSV, and JSON options", async () => {
      await renderLoaded();

      fireEvent.click(screen.getByRole("button", { name: /export/i }));

      expect(screen.getByRole("menuitem", { name: /export as pdf/i })).toBeInTheDocument();
      expect(screen.getByRole("menuitem", { name: /export as csv/i })).toBeInTheDocument();
      expect(screen.getByRole("menuitem", { name: /export as json/i })).toBeInTheDocument();
    });

    it("triggers a PDF export of the dashboard element", async () => {
      await renderLoaded();

      fireEvent.click(screen.getByRole("button", { name: /export/i }));
      fireEvent.click(screen.getByRole("menuitem", { name: /export as pdf/i }));

      await waitFor(() => {
        expect(exportElementToPDF).toHaveBeenCalledTimes(1);
      });
      const [element, filename] = (exportElementToPDF as Mock).mock.calls[0];
      expect(element).toBeInstanceOf(HTMLElement);
      expect(filename).toMatch(/^dashboard-.*\.pdf$/);
    });

    it("triggers a CSV export with collaborator rows", async () => {
      await renderLoaded();

      fireEvent.click(screen.getByRole("button", { name: /export/i }));
      fireEvent.click(screen.getByRole("menuitem", { name: /export as csv/i }));

      expect(downloadDashboardCSV).toHaveBeenCalledTimes(1);
      const [csv, filename] = (downloadDashboardCSV as Mock).mock.calls[0];
      expect(csv).toContain("Collaborator Address");
      expect(csv).toContain(MOCK_WALLET);
      expect(filename).toMatch(/^dashboard-.*\.csv$/);
    });

    it("triggers a JSON export with dashboard totals", async () => {
      await renderLoaded();

      fireEvent.click(screen.getByRole("button", { name: /export/i }));
      fireEvent.click(screen.getByRole("menuitem", { name: /export as json/i }));

      expect(downloadDashboardJSON).toHaveBeenCalledTimes(1);
      const [json, filename] = (downloadDashboardJSON as Mock).mock.calls[0];
      const parsed = JSON.parse(json);
      expect(parsed.totalDistributed).toBe(1000);
      expect(parsed.contractId).toBe(MOCK_CONTRACT);
      expect(filename).toMatch(/^dashboard-.*\.json$/);
    });

    it("shows an error banner when PDF export fails", async () => {
      (exportElementToPDF as Mock).mockRejectedValueOnce(new Error("canvas failed"));
      await renderLoaded();

      fireEvent.click(screen.getByRole("button", { name: /export/i }));
      fireEvent.click(screen.getByRole("menuitem", { name: /export as pdf/i }));

      await waitFor(() => {
        expect(screen.getByRole("alert")).toHaveTextContent(/failed to generate pdf export/i);
      });
    });
  });

  describe("multi-contract selector", () => {
    const CONTRACT_B = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

    function mockApisFor(contractTotals: Record<string, number>) {
      mockGetAnalytics.mockImplementation((id: string) =>
        Promise.resolve({
          success: true,
          data: {
            totalDistributed: contractTotals[id] ?? 0,
            primaryRoyaltiesTotal: contractTotals[id] ?? 0,
            secondaryRoyaltiesTotal: 0,
            collaboratorStats: [],
          },
        }),
      );
      mockUseAnalytics.mockImplementation((id: string) =>
        queryResult({
          success: true,
          data: {
            totalDistributed: contractTotals[id] ?? 0,
            primaryRoyaltiesTotal: contractTotals[id] ?? 0,
            secondaryRoyaltiesTotal: 0,
            collaboratorStats: [],
          },
        }),
      );
      mockUseCollaborators.mockReturnValue(queryResult(mockCollaborators));
      mockUseRoyaltyStats.mockReturnValue(queryResult({}));
      mockUseTransactionHistory.mockReturnValue(queryResult({ data: [] }));
      mockUseSecondarySales.mockReturnValue(queryResult({ sales: [] }));
    }

    it("renders the contract selector with tracked contracts", async () => {
      setTrackedContracts([MOCK_CONTRACT, CONTRACT_B]);
      mockApisFor({ [MOCK_CONTRACT]: 1000, [CONTRACT_B]: 500 });

      render(<EarningsDashboard contractId={MOCK_CONTRACT} />);

      const selector = await screen.findByTestId("contract-selector");
      expect(selector).toBeInTheDocument();

      const options = within(screen.getByTestId("contract-selector")).getAllByRole("option");
      // Two contracts + "All Contracts" aggregate option
      expect(options).toHaveLength(3);
      expect(
        screen.getByRole("option", { name: /All Contracts/i }),
      ).toBeInTheDocument();
    });

    it("switches to the selected contract and refetches its earnings", async () => {
      setTrackedContracts([MOCK_CONTRACT, CONTRACT_B]);
      mockApisFor({ [MOCK_CONTRACT]: 1000, [CONTRACT_B]: 500 });

      render(<EarningsDashboard contractId={MOCK_CONTRACT} />);

      await waitFor(() => {
        expect(screen.getByTestId("earnings-dashboard")).toBeInTheDocument();
      });
      await screen.findByTestId("contract-selector");
      // Total Distributed and Primary Royalties both equal 1,000
      expect(screen.getAllByText("1,000 XLM").length).toBeGreaterThan(0);

      fireEvent.change(screen.getByLabelText(/Contract/i), {
        target: { value: CONTRACT_B },
      });

      await waitFor(() => {
        expect(mockUseAnalytics).toHaveBeenCalledWith(CONTRACT_B);
      });
      await waitFor(() => {
        expect(screen.getAllByText("500 XLM").length).toBeGreaterThan(0);
      });
    });

    it("shows the aggregated comparison view when All Contracts is selected", async () => {
      setTrackedContracts([MOCK_CONTRACT, CONTRACT_B]);
      mockApisFor({ [MOCK_CONTRACT]: 1000, [CONTRACT_B]: 500 });

      render(<EarningsDashboard contractId={MOCK_CONTRACT} />);

      await waitFor(() => {
        expect(screen.getByTestId("earnings-dashboard")).toBeInTheDocument();
      });
      await screen.findByTestId("contract-selector");

      fireEvent.change(screen.getByLabelText(/Contract/i), {
        target: { value: "__all__" },
      });

      await waitFor(() => {
        expect(
          screen.getByTestId("multi-contract-comparison"),
        ).toBeInTheDocument();
      });
      // Aggregated total = 1000 + 500
      expect(screen.getByTestId("total-all-distributed")).toHaveTextContent(
        "1,500",
      );
    });
  });
});
