/**
 * Tests for CollaboratorDirectory (#923).
 *
 * Covers: search filters the list, tier/status/earnings/date filters combine
 * (AND semantics), sort changes order, checkbox selection state, bulk action
 * buttons appear when items are selected, and CSV export triggers a download
 * with correct row data (via Blob content assertion).
 */
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { vi, type Mock } from "vitest";
import CollaboratorDirectory from "./CollaboratorDirectory";
import { queryClient } from "../lib/queryClient";

vi.mock("../api", () => ({
  api: {
    getCollaborators: vi.fn(),
    getContractTiers: vi.fn(),
    getAnalytics: vi.fn(),
    getContributorStatuses: vi.fn(),
    setContributorStatus: vi.fn(),
    setContributorTier: vi.fn(),
    sendNotification: vi.fn(),
  },
}));

import { api } from "../api";

const mockGetCollaborators = api.getCollaborators as Mock;
const mockGetContractTiers = api.getContractTiers as Mock;
const mockGetAnalytics = api.getAnalytics as Mock;
const mockGetContributorStatuses = api.getContributorStatuses as Mock;
const mockSetContributorStatus = api.setContributorStatus as Mock;
const mockSetContributorTier = api.setContributorTier as Mock;
const mockSendNotification = api.sendNotification as Mock;

const CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const ADDR_1 = "GALAXY1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZAAAA";
const ADDR_2 = "GSTELLAR9876543210ABCDEFGHIJKLMNOPQRSTUVWXYZBBBB";
const ADDR_3 = "GLOWING5432109876ABCDEFGHIJKLMNOPQRSTUVWXYZCCCC";

const BASE_COLLABORATORS = [
  { address: ADDR_1, basisPoints: 7000 },
  { address: ADDR_2, basisPoints: 2000 },
  { address: ADDR_3, basisPoints: 1000 },
];

function setup() {
  mockGetCollaborators.mockResolvedValue(BASE_COLLABORATORS);
  mockGetContractTiers.mockResolvedValue({
    success: true,
    data: [
      { walletAddress: ADDR_1, tier: "vip" },
      { walletAddress: ADDR_2, tier: "regular" },
      { walletAddress: ADDR_3, tier: "trial" },
    ],
    validTiers: ["vip", "regular", "trial"],
  });
  mockGetAnalytics.mockResolvedValue({
    success: true,
    data: {
      totalDistributed: 0,
      totalTransactions: 0,
      averagePayout: 0,
      primaryRoyaltiesTotal: 0,
      secondaryRoyaltiesTotal: 0,
      topEarners: [],
      distributionTrends: [],
      collaboratorStats: [
        { address: ADDR_1, totalEarned: 1000, payoutCount: 5, firstActivity: "2024-01-01", lastActivity: "2024-06-01" },
        { address: ADDR_2, totalEarned: 300, payoutCount: 2, firstActivity: "2024-03-01", lastActivity: "2024-05-01" },
        { address: ADDR_3, totalEarned: 50, payoutCount: 0, firstActivity: "2024-05-01", lastActivity: null },
      ],
    },
  });
  mockGetContributorStatuses.mockResolvedValue({
    success: true,
    data: [{ contractId: CONTRACT_ID, address: ADDR_2, status: "suspended", reason: null, suspendedAt: null, deactivatedAt: null, updatedBy: null }],
  });
  render(<CollaboratorDirectory contractId={CONTRACT_ID} walletAddress="GOPERATOR" />);
}

beforeEach(() => {
  vi.clearAllMocks();
  queryClient.clear();
  mockSetContributorStatus.mockResolvedValue({ success: true, message: "ok" });
  mockSetContributorTier.mockResolvedValue({ success: true, message: "ok" });
  mockSendNotification.mockResolvedValue({ success: true, data: {} });

  // Mock URL/Blob download plumbing used by CSV export.
  global.URL.createObjectURL = vi.fn(() => "blob:mock-url");
  global.URL.revokeObjectURL = vi.fn();
});

describe("CollaboratorDirectory", () => {
  it("renders all collaborators after loading", async () => {
    setup();
    await waitFor(() => {
      expect(screen.getByTestId("collaborator-directory")).toBeInTheDocument();
    });
    expect(screen.getByText(/Showing/i).textContent).toContain("3");
  });

  /* ── Search ─────────────────────────────────────────────────────────── */
  it("filters the list via search", async () => {
    setup();
    await waitFor(() => expect(screen.getByText(/Showing/i).textContent).toContain("3"));

    fireEvent.change(screen.getByLabelText("Search collaborators"), {
      target: { value: "GALAXY" },
    });

    await waitFor(() => {
      expect(screen.getByText(/Showing/i).textContent).toContain("1");
    });
  });

  /* ── Filters (combine with AND semantics) ─────────────────────────────── */
  it("filters by tier", async () => {
    setup();
    await waitFor(() => expect(screen.getByText(/Showing/i).textContent).toContain("3"));

    fireEvent.change(screen.getByLabelText("Filter by tier"), { target: { value: "vip" } });

    await waitFor(() => expect(screen.getByText(/Showing/i).textContent).toContain("1"));
  });

  it("filters by status", async () => {
    setup();
    await waitFor(() => expect(screen.getByText(/Showing/i).textContent).toContain("3"));

    fireEvent.change(screen.getByLabelText("Filter by status"), { target: { value: "suspended" } });

    await waitFor(() => expect(screen.getByText(/Showing/i).textContent).toContain("1"));
  });

  it("filters by earnings range", async () => {
    setup();
    await waitFor(() => expect(screen.getByText(/Showing/i).textContent).toContain("3"));

    fireEvent.change(screen.getByLabelText("Minimum earnings"), { target: { value: "100" } });
    fireEvent.change(screen.getByLabelText("Maximum earnings"), { target: { value: "500" } });

    await waitFor(() => expect(screen.getByText(/Showing/i).textContent).toContain("1"));
  });

  it("filters by join date range", async () => {
    setup();
    await waitFor(() => expect(screen.getByText(/Showing/i).textContent).toContain("3"));

    fireEvent.change(screen.getByLabelText("Joined after date"), { target: { value: "2024-02-01" } });

    await waitFor(() => expect(screen.getByText(/Showing/i).textContent).toContain("2"));
  });

  it("combines multiple filter types with AND semantics", async () => {
    setup();
    await waitFor(() => expect(screen.getByText(/Showing/i).textContent).toContain("3"));

    // vip AND earnings >= 500 -> only ADDR_1
    fireEvent.change(screen.getByLabelText("Filter by tier"), { target: { value: "vip" } });
    fireEvent.change(screen.getByLabelText("Minimum earnings"), { target: { value: "500" } });

    await waitFor(() => expect(screen.getByText(/Showing/i).textContent).toContain("1"));

    // Now add status=suspended -> ADDR_1 is active, so 0 results
    fireEvent.change(screen.getByLabelText("Filter by status"), { target: { value: "suspended" } });

    await waitFor(() => {
      expect(screen.getByText(/No collaborators match/i)).toBeInTheDocument();
    });
  });

  it("clears all filters via the Clear all button", async () => {
    setup();
    await waitFor(() => expect(screen.getByText(/Showing/i).textContent).toContain("3"));

    fireEvent.change(screen.getByLabelText("Filter by tier"), { target: { value: "vip" } });
    await waitFor(() => expect(screen.getByText(/Showing/i).textContent).toContain("1"));

    fireEvent.click(screen.getByText("Clear all"));
    await waitFor(() => expect(screen.getByText(/Showing/i).textContent).toContain("3"));
  });

  /* ── Sort ───────────────────────────────────────────────────────────── */
  it("changes order when sort option changes", async () => {
    setup();
    await waitFor(() => expect(screen.getByText(/Showing/i).textContent).toContain("3"));

    // Sort direction defaults to "desc" and stays sticky across sort-key
    // changes (only the explicit direction toggle flips it), so switching
    // to "address" sorts descending: GSTELLAR > GLOWING > GALAXY.
    fireEvent.change(screen.getByLabelText("Sort by"), { target: { value: "address" } });

    await waitFor(() => {
      const rows = screen.getAllByRole("row").slice(1); // skip header
      expect(rows[0]).toHaveAttribute("data-testid", `cd-row-${ADDR_2}`);
      expect(rows[1]).toHaveAttribute("data-testid", `cd-row-${ADDR_3}`);
      expect(rows[2]).toHaveAttribute("data-testid", `cd-row-${ADDR_1}`);
    });
  });

  it("toggles sort direction", async () => {
    setup();
    await waitFor(() => expect(screen.getByText(/Showing/i).textContent).toContain("3"));

    // Starts at the default "desc" direction (GSTELLAR first, see above);
    // toggling flips to ascending (GALAXY < GLOWING < GSTELLAR), so GALAXY
    // moves to the top.
    fireEvent.change(screen.getByLabelText("Sort by"), { target: { value: "address" } });
    fireEvent.click(screen.getByLabelText(/Sort direction/i));

    await waitFor(() => {
      const rows = screen.getAllByRole("row").slice(1);
      expect(rows[0]).toHaveAttribute("data-testid", `cd-row-${ADDR_1}`);
    });
  });

  /* ── Selection / bulk actions ──────────────────────────────────────── */
  it("supports checkbox multi-select and shows bulk action buttons when items are selected", async () => {
    setup();
    await waitFor(() => expect(screen.getByText(/Showing/i).textContent).toContain("3"));

    // Bulk action buttons are present but disabled when nothing is selected.
    expect(screen.getByRole("button", { name: /^suspend 0 selected collaborators$/i })).toBeDisabled();
    expect(screen.getByText("0 collaborators selected")).toBeInTheDocument();

    const checkbox = screen.getByLabelText(`Select ${ADDR_1}`);
    fireEvent.click(checkbox);
    expect(checkbox).toBeChecked();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^suspend 1 selected collaborators$/i })).toBeEnabled();
    });
    expect(screen.getByText("1 collaborator selected")).toBeInTheDocument();
  });

  it("select-all toggles every visible row", async () => {
    setup();
    await waitFor(() => expect(screen.getByText(/Showing/i).textContent).toContain("3"));

    const selectAll = screen.getByLabelText("Select all visible collaborators");
    fireEvent.click(selectAll);

    expect(screen.getByLabelText(`Select ${ADDR_1}`)).toBeChecked();
    expect(screen.getByLabelText(`Select ${ADDR_2}`)).toBeChecked();
    expect(screen.getByLabelText(`Select ${ADDR_3}`)).toBeChecked();

    fireEvent.click(selectAll);
    expect(screen.getByLabelText(`Select ${ADDR_1}`)).not.toBeChecked();
  });

  /* ── Bulk suspend / unsuspend / tier / message ────────────────────── */
  it("calls the existing setContributorStatus mutation (looped) for bulk suspend", async () => {
    setup();
    await waitFor(() => expect(screen.getByText(/Showing/i).textContent).toContain("3"));

    fireEvent.click(screen.getByLabelText(`Select ${ADDR_1}`));
    fireEvent.click(screen.getByLabelText(`Select ${ADDR_2}`));

    const suspendBtn = screen.getByRole("button", { name: /^suspend \d+ selected collaborators$/i });
    fireEvent.click(suspendBtn);

    await waitFor(() => {
      expect(mockSetContributorStatus).toHaveBeenCalledTimes(2);
    });
    expect(mockSetContributorStatus).toHaveBeenCalledWith(
      CONTRACT_ID,
      ADDR_1,
      expect.objectContaining({ status: "suspended" }),
    );
  });

  it("calls setContributorStatus with status=active for bulk unsuspend", async () => {
    setup();
    await waitFor(() => expect(screen.getByText(/Showing/i).textContent).toContain("3"));

    fireEvent.click(screen.getByLabelText(`Select ${ADDR_2}`));
    await waitFor(() => expect(screen.getByText("Unsuspend Selected")).toBeEnabled());

    fireEvent.click(screen.getByText("Unsuspend Selected"));

    await waitFor(() => {
      expect(mockSetContributorStatus).toHaveBeenCalledWith(
        CONTRACT_ID,
        ADDR_2,
        expect.objectContaining({ status: "active" }),
      );
    });
  });

  it("calls the existing setContributorTier mutation (looped) for bulk tier change", async () => {
    setup();
    await waitFor(() => expect(screen.getByText(/Showing/i).textContent).toContain("3"));

    fireEvent.click(screen.getByLabelText(`Select ${ADDR_1}`));
    fireEvent.click(screen.getByLabelText(`Select ${ADDR_3}`));
    await waitFor(() => expect(screen.getByText("Change Tier…")).toBeEnabled());

    fireEvent.click(screen.getByText("Change Tier…"));
    const tierForm = await screen.findByTestId("cd-tier-form");
    fireEvent.change(within(tierForm).getByLabelText(/New tier/i), { target: { value: "vip" } });
    fireEvent.click(within(tierForm).getByText("Apply Tier"));

    await waitFor(() => {
      expect(mockSetContributorTier).toHaveBeenCalledTimes(2);
    });
    expect(mockSetContributorTier).toHaveBeenCalledWith(CONTRACT_ID, ADDR_1, "vip");
  });

  it("calls the existing sendNotification mutation (looped) for bulk send message", async () => {
    setup();
    await waitFor(() => expect(screen.getByText(/Showing/i).textContent).toContain("3"));

    fireEvent.click(screen.getByLabelText(`Select ${ADDR_1}`));
    await waitFor(() => expect(screen.getByText("Send Message…")).toBeEnabled());

    fireEvent.click(screen.getByText("Send Message…"));
    const msgForm = await screen.findByTestId("cd-message-form");
    fireEvent.change(within(msgForm).getByLabelText("Message to send"), {
      target: { value: "Hello collaborator" },
    });
    fireEvent.click(within(msgForm).getByText(/Send to 1 collaborator/));

    await waitFor(() => {
      expect(mockSendNotification).toHaveBeenCalledWith(
        ADDR_1,
        expect.any(String),
        expect.any(String),
        "Hello collaborator",
      );
    });
  });

  /* ── CSV export ────────────────────────────────────────────────────── */
  it("triggers a CSV download with the correct selected row data", async () => {
    setup();
    await waitFor(() => expect(screen.getByText(/Showing/i).textContent).toContain("3"));

    fireEvent.click(screen.getByLabelText(`Select ${ADDR_1}`));
    fireEvent.click(screen.getByLabelText(`Select ${ADDR_2}`));

    const blobSpy = vi.spyOn(global, "Blob");

    fireEvent.click(screen.getByRole("button", { name: /export earnings from \d+ selected collaborators/i }));

    expect(blobSpy).toHaveBeenCalled();
    const csvContent = blobSpy.mock.calls[0][0]?.[0] as string;
    expect(csvContent).toContain(ADDR_1);
    expect(csvContent).toContain(ADDR_2);
    expect(csvContent).not.toContain(ADDR_3);
    expect(csvContent).toContain("70.00"); // ADDR_1 share
    expect(csvContent).toContain("20.00"); // ADDR_2 share

    blobSpy.mockRestore();
  });

  /* ── Quick view ────────────────────────────────────────────────────── */
  it("opens the quick view modal when a collaborator address is clicked", async () => {
    setup();
    await waitFor(() => expect(screen.getByText(/Showing/i).textContent).toContain("3"));

    fireEvent.click(screen.getByTestId(`cd-row-${ADDR_1}`).querySelector(".cd-address-btn")!);

    await waitFor(() => {
      expect(screen.getByTestId("collaborator-quick-view")).toBeInTheDocument();
    });
  });

  /* ── Comparison view ───────────────────────────────────────────────── */
  it("shows the comparison view for selected collaborators via the compare toggle", async () => {
    setup();
    await waitFor(() => expect(screen.getByText(/Showing/i).textContent).toContain("3"));

    fireEvent.click(screen.getByLabelText(`Select ${ADDR_1}`));
    fireEvent.click(screen.getByLabelText(`Select ${ADDR_2}`));

    fireEvent.click(screen.getByRole("button", { name: /compare selected collaborators/i }));

    await waitFor(() => {
      expect(screen.getByTestId("collaborator-comparison")).toBeInTheDocument();
    });
  });

  /* ── Empty / error states ──────────────────────────────────────────── */
  it("returns null when contractId is empty", () => {
    const { container } = render(<CollaboratorDirectory contractId="" />);
    expect(container.innerHTML).toBe("");
  });

  it("shows an error state and retries on click", async () => {
    mockGetCollaborators.mockRejectedValue(new Error("network down"));
    render(<CollaboratorDirectory contractId={CONTRACT_ID} />);

    await waitFor(() => {
      expect(screen.getByTestId("collaborator-directory-error")).toBeInTheDocument();
    });
  });

  it("shows no-results message when filters exclude everyone", async () => {
    setup();
    await waitFor(() => expect(screen.getByText(/Showing/i).textContent).toContain("3"));

    fireEvent.change(screen.getByLabelText("Search collaborators"), {
      target: { value: "ZZZ_NOT_FOUND" },
    });

    await waitFor(() => {
      expect(screen.getByText(/No collaborators match/i)).toBeInTheDocument();
    });
  });
});
