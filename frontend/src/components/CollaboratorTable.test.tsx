/**
 * Tests for the enhanced CollaboratorTable component.
 *
 * Covers: search, filters, sort, name editing, edge cases, large lists.
 *
 * Run with: cd frontend && npx vitest run src/components/CollaboratorTable.test.tsx
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { vi, type Mock } from "vitest";
import "@testing-library/jest-dom";
import CollaboratorTable from "./CollaboratorTable";
import { queryClient } from "../lib/queryClient";

// Mock the API module
vi.mock("../api", () => ({
  api: {
    getCollaborators: vi.fn(),
    getAnalytics: vi.fn(),
    getContractTiers: vi.fn(),
  },
}));

import { api } from "../api";

const mockGetCollaborators = api.getCollaborators as Mock;
const mockGetAnalytics = api.getAnalytics as Mock;
const mockGetContractTiers = api.getContractTiers as Mock;

const MOCK_CONTRACT =
  "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const mockCollaborators = [
  {
    address: "GALAXY1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZAAAA",
    basisPoints: 7000,
  },
  {
    address: "GSTELLAR9876543210ABCDEFGHIJKLMNOPQRSTUVWXYZBBBB",
    basisPoints: 2000,
  },
  {
    address: "GLOWING5432109876ABCDEFGHIJKLMNOPQRSTUVWXYZCCCC",
    basisPoints: 500,
  },
  {
    address: "GSHINY0987654321ABCDEFGHIJKLMNOPQRSTUVWXYZDDDD",
    basisPoints: 400,
  },
  {
    address: "GBRIGHT1357924680ABCDEFGHIJKLMNOPQRSTUVWXYZEEEE",
    basisPoints: 100,
  },
];

function setup(mockData = mockCollaborators) {
  mockGetCollaborators.mockResolvedValue(mockData);
  mockGetAnalytics.mockResolvedValue({
    success: true,
    data: { collaboratorStats: [] },
  });
  render(<CollaboratorTable contractId={MOCK_CONTRACT} refreshKey={0} />);
}

beforeEach(() => {
  vi.clearAllMocks();
  queryClient.clear();
  localStorage.clear();
  mockGetAnalytics.mockResolvedValue({
    success: true,
    data: { collaboratorStats: [] },
  });
  mockGetContractTiers.mockResolvedValue({ data: [] });
});

describe("CollaboratorTable", () => {
  /* ── Basic rendering ──────────────────────────────────────────────────── */
  it("renders the collaborators table after loading", async () => {
    setup();
    await waitFor(() => {
      expect(screen.getByText("Collaborators")).toBeTruthy();
    });

    // Should show all 5 collaborators
    const countText = screen.getByText(/Showing/i).textContent || "";
    expect(countText).toContain("5");
  });

  it("shows loading state initially", () => {
    mockGetCollaborators.mockReturnValue(
      new Promise(() => {
        /* never resolves */
      }),
    );
    render(
      <CollaboratorTable contractId={MOCK_CONTRACT} refreshKey={0} />,
    );
    expect(screen.getByText(/Loading/i)).toBeTruthy();
  });

  it("renders a skeleton placeholder (not blank) while loading", () => {
    mockGetCollaborators.mockReturnValue(
      new Promise(() => {
        /* never resolves */
      }),
    );
    const { container } = render(
      <CollaboratorTable contractId={MOCK_CONTRACT} refreshKey={0} />,
    );

    // Layout-preserving placeholder rows, not just a status line.
    expect(container.querySelectorAll(".table-skeleton-row").length).toBe(5);
    expect(screen.getByRole("status")).toBeTruthy();
  });

  it("replaces the skeleton with real rows once data loads", async () => {
    setup();
    // Skeleton is present synchronously on first render.
    expect(screen.getByRole("status")).toBeTruthy();

    await waitFor(() => {
      expect(screen.getByText("Collaborators")).toBeTruthy();
    });

    // Skeleton is gone once the table has data.
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows error state when API fails", async () => {
    mockGetCollaborators.mockRejectedValue(new Error("Network error"));
    render(
      <CollaboratorTable contractId={MOCK_CONTRACT} refreshKey={0} />,
    );
    await waitFor(() => {
      expect(screen.getByText("Network error")).toBeTruthy();
    });
  });

  it("shows a Retry button on error and re-fetches when clicked (#747)", async () => {
    mockGetCollaborators.mockRejectedValueOnce(new Error("Network error"));
    render(<CollaboratorTable contractId={MOCK_CONTRACT} refreshKey={0} />);

    await waitFor(() => {
      expect(screen.getByText("Network error")).toBeTruthy();
    });

    const retryButton = screen.getByRole("button", { name: /retry/i });
    expect(retryButton).toBeTruthy();

    mockGetCollaborators.mockResolvedValueOnce(mockCollaborators);
    fireEvent.click(retryButton);

    await waitFor(() => {
      expect(screen.queryByText("Network error")).toBeNull();
      expect(screen.getByText("Collaborators")).toBeTruthy();
    });
    expect(mockGetCollaborators).toHaveBeenCalledTimes(2);
  });

  it("shows empty message when no collaborators exist", async () => {
    mockGetCollaborators.mockResolvedValue([]);
    render(
      <CollaboratorTable contractId={MOCK_CONTRACT} refreshKey={0} />,
    );
    await waitFor(() => {
      expect(
        screen.getByText(/No collaborators found/i),
      ).toBeTruthy();
    });
  });

  it("returns null when contractId is empty", () => {
    const { container } = render(
      <CollaboratorTable contractId="" refreshKey={0} />,
    );
    expect(container.innerHTML).toBe("");
  });

  /* ── Search ──────────────────────────────────────────────────────────── */
  it("finds collaborator by address substring", async () => {
    setup();
    await waitFor(() => {
      const countText =
        screen.getByText(/Showing/i).textContent || "";
      expect(countText).toContain("5");
    });

    const searchInput = screen.getByPlaceholderText(
      /Search by address/i,
    );
    fireEvent.change(searchInput, { target: { value: "GALAXY" } });

    // Debounced — wait for the result
    await waitFor(
      () => {
        const countText =
          screen.getByText(/Showing/i).textContent || "";
        expect(countText).toContain("1");
      },
      { timeout: 500 },
    );

    // Verify we have a single result (the matched address row)
    const rows = screen.getAllByRole("row");
    // header row + 1 data row
    expect(rows.length).toBe(2);
  });

  it("finds collaborator by saved name", async () => {
    // Pre-seed a name in localStorage (new JSON blob format)
    const blob = JSON.stringify({
      [MOCK_CONTRACT]: {
        "GALAXY1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZAAAA": "Alice",
      },
    });
    localStorage.setItem("srs_collab_names", blob);

    setup();
    await waitFor(() => {
      const countText =
        screen.getByText(/Showing/i).textContent || "";
      expect(countText).toContain("5");
    });

    // The name should be displayed
    expect(screen.getByText("Alice")).toBeTruthy();

    // Search by name
    const searchInput = screen.getByPlaceholderText(
      /Search by address/i,
    );
    fireEvent.change(searchInput, { target: { value: "Alice" } });

    await waitFor(
      () => {
        const countText =
          screen.getByText(/Showing/i).textContent || "";
        expect(countText).toContain("1");
      },
      { timeout: 500 },
    );
  });

  it("shows no results when search doesn't match anything", async () => {
    setup();
    await waitFor(() => {
      const countText =
        screen.getByText(/Showing/i).textContent || "";
      expect(countText).toContain("5");
    });

    const searchInput = screen.getByPlaceholderText(
      /Search by address/i,
    );
    fireEvent.change(searchInput, {
      target: { value: "ZZZ_NOT_FOUND_ZZZ" },
    });

    await waitFor(
      () => {
        expect(
          screen.getByText(/No collaborators match/i),
        ).toBeTruthy();
      },
      { timeout: 500 },
    );
  });

  it("clears search with the clear button", async () => {
    setup();
    await waitFor(() => {
      const countText =
        screen.getByText(/Showing/i).textContent || "";
      expect(countText).toContain("5");
    });

    const searchInput = screen.getByPlaceholderText(
      /Search by address/i,
    );
    fireEvent.change(searchInput, { target: { value: "GALAXY" } });

    await waitFor(
      () => {
        const countText =
          screen.getByText(/Showing/i).textContent || "";
        expect(countText).toContain("1");
      },
      { timeout: 500 },
    );

    // Click the clear button
    const clearBtn = screen.getByLabelText("Clear search");
    fireEvent.click(clearBtn);

    await waitFor(
      () => {
        const countText =
          screen.getByText(/Showing/i).textContent || "";
        expect(countText).toContain("5");
      },
      { timeout: 500 },
    );
  });

  /* ── Filters ─────────────────────────────────────────────────────────── */
  it("filters by share range > 10%", async () => {
    setup();
    await waitFor(() => {
      const countText =
        screen.getByText(/Showing/i).textContent || "";
      expect(countText).toContain("5");
    });

    const shareSelect = screen.getByLabelText(
      /Filter by share percentage/i,
    );
    fireEvent.change(shareSelect, { target: { value: "gt10" } });

    // 7000 bp = 70% and 2000 bp = 20% are both > 10%
    await waitFor(() => {
      const countText =
        screen.getByText(/Showing/i).textContent || "";
      expect(countText).toContain("2");
      // Percentages also appear in the allocation chart legend, so use *AllBy*
      expect(screen.getAllByText("70.00%").length).toBeGreaterThan(0);
      expect(screen.getAllByText("20.00%").length).toBeGreaterThan(0);
    });
  });

  it("filters by share range < 1%", async () => {
    setup();
    await waitFor(() => {
      const countText =
        screen.getByText(/Showing/i).textContent || "";
      expect(countText).toContain("5");
    });

    const shareSelect = screen.getByLabelText(
      /Filter by share percentage/i,
    );
    fireEvent.change(shareSelect, { target: { value: "lt1" } });

    // 100 bp = 1% is NOT < 1%, so no collaborator should show
    await waitFor(() => {
      expect(
        screen.getByText(/No collaborators match/i),
      ).toBeTruthy();
    });
  });

  it("combines search and share filter (AND logic)", async () => {
    setup();
    await waitFor(() => {
      const countText =
        screen.getByText(/Showing/i).textContent || "";
      expect(countText).toContain("5");
    });

    // Search for GSTELLAR (20%, 1 result)
    const searchInput = screen.getByPlaceholderText(
      /Search by address/i,
    );
    fireEvent.change(searchInput, { target: { value: "GSTELLAR" } });

    await waitFor(
      () => {
        const countText =
          screen.getByText(/Showing/i).textContent || "";
        expect(countText).toContain("1");
      },
      { timeout: 500 },
    );

    // Add share filter: 1-5% — GSTELLAR is 20%, should yield 0
    const shareSelect = screen.getByLabelText(
      /Filter by share percentage/i,
    );
    fireEvent.change(shareSelect, { target: { value: "r1to5" } });

    await waitFor(() => {
      expect(
        screen.getByText(/No collaborators match/i),
      ).toBeTruthy();
    });
  });

  it("shows active filter chips and can remove them", async () => {
    setup();
    await waitFor(() => {
      const countText =
        screen.getByText(/Showing/i).textContent || "";
      expect(countText).toContain("5");
    });

    // Apply share filter
    const shareSelect = screen.getByLabelText(
      /Filter by share percentage/i,
    );
    fireEvent.change(shareSelect, { target: { value: "gt10" } });

    await waitFor(() => {
      // The chip shows "> 10%" — getAllByText returns both the chip
      // and a select option. Use a specific filter chip selector.
      const chips = screen.getAllByText("> 10%");
      expect(chips.length).toBeGreaterThanOrEqual(1);
    });

    // Remove the chip
    const removeBtn = screen.getByLabelText(
      "Remove filter: > 10%",
    );
    fireEvent.click(removeBtn);

    await waitFor(() => {
      const countText =
        screen.getByText(/Showing/i).textContent || "";
      expect(countText).toContain("5");
    });
  });

  it("clear all button resets all filters and search", async () => {
    setup();
    await waitFor(() => {
      const countText =
        screen.getByText(/Showing/i).textContent || "";
      expect(countText).toContain("5");
    });

    // Apply both search and share filter
    const shareSelect = screen.getByLabelText(
      /Filter by share percentage/i,
    );
    fireEvent.change(shareSelect, { target: { value: "lt1" } });

    const searchInput = screen.getByPlaceholderText(
      /Search by address/i,
    );
    fireEvent.change(searchInput, { target: { value: "GALAXY" } });

    await waitFor(
      () => {
        expect(
          screen.getByText(/No collaborators match/i),
        ).toBeTruthy();
      },
      { timeout: 500 },
    );

    // Click "Clear all"
    const clearAllBtn = screen.getByText("Clear all");
    fireEvent.click(clearAllBtn);

    await waitFor(
      () => {
        const countText =
          screen.getByText(/Showing/i).textContent || "";
        expect(countText).toContain("5");
      },
      { timeout: 500 },
    );
  });

  /* ── Sorting ─────────────────────────────────────────────────────────── */
  it("sorts by name (address) A-Z", async () => {
    setup();
    await waitFor(() => {
      const countText =
        screen.getByText(/Showing/i).textContent || "";
      expect(countText).toContain("5");
    });

    const sortBtn = screen.getByText("A–Z");
    fireEvent.click(sortBtn);

    expect(sortBtn.className).toContain(
      "collab-sort-btn--active",
    );
  });

  it("sorts by share descending by default", async () => {
    setup();
    await waitFor(() => {
      const countText =
        screen.getByText(/Showing/i).textContent || "";
      expect(countText).toContain("5");
    });

    const shareBtn = screen.getByText("Share ↓");
    expect(shareBtn.className).toContain(
      "collab-sort-btn--active",
    );
  });

  /* ── Result count accuracy ──────────────────────────────────────────── */
  it("shows accurate result count after filtering", async () => {
    setup();
    await waitFor(() => {
      const countText =
        screen.getByText(/Showing/i).textContent || "";
      expect(countText).toContain("5");
    });

    const shareSelect = screen.getByLabelText(
      /Filter by share percentage/i,
    );
    fireEvent.change(shareSelect, { target: { value: "r5to10" } });

    // 5-10% captures only the 500 bp (5%) collaborator (400 bp = 4%, 100 bp = 1%)
    await waitFor(() => {
      const countText =
        screen.getByText(/Showing/i).textContent || "";
      expect(countText).toContain("1");
    });
  });

  /* ── Name editing ───────────────────────────────────────────────────── */
  it("allows editing a collaborator name", async () => {
    setup();
    await waitFor(() => {
      const countText =
        screen.getByText(/Showing/i).textContent || "";
      expect(countText).toContain("5");
    });

    // Find clickable name display spans (they have title="Click to add a name")
    const nameDisplays = screen.getAllByTitle("Click to add a name");
    expect(nameDisplays.length).toBeGreaterThan(0);

    // Click the first one to enter edit mode
    fireEvent.click(nameDisplays[0]);

    // An input should appear
    const nameInput = screen.getByPlaceholderText(
      /Name or note/i,
    );
    expect(nameInput).toBeTruthy();

    // Type a name
    fireEvent.change(nameInput, { target: { value: "Alice" } });
    fireEvent.keyDown(nameInput, { key: "Enter" });

    // The name should now be displayed
    await waitFor(() => {
      expect(screen.getByText("Alice")).toBeTruthy();
    });
  });

  /* ── Large list performance ──────────────────────────────────────────── */
  it("handles large collaborator lists", async () => {
    const largeList = Array.from({ length: 150 }, (_, i) => ({
      address: "G" + String(i).padStart(55, "A"),
      basisPoints: Math.floor(10000 / 150),
    }));
    mockGetCollaborators.mockResolvedValue(largeList);
    render(
      <CollaboratorTable contractId={MOCK_CONTRACT} refreshKey={0} />,
    );

    await waitFor(() => {
      const countText =
        screen.getByText(/Showing/i).textContent || "";
      expect(countText).toContain("150");
    });

    // Search for a specific address
    const searchInput = screen.getByPlaceholderText(
      /Search by address/i,
    );
    fireEvent.change(searchInput, { target: { value: "G0A" } });

    await waitFor(
      () => {
        const countText =
          screen.getByText(/Showing/i).textContent || "";
        expect(countText).toContain("1");
      },
      { timeout: 500 },
    );
  });

  /* ── Single collaborator edge case ───────────────────────────────────── */
  it("handles single collaborator edge case", async () => {
    const singleList = [
      {
        address:
          "GONLY1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZFFFF",
        basisPoints: 10000,
      },
    ];
    mockGetCollaborators.mockResolvedValue(singleList);
    render(
      <CollaboratorTable contractId={MOCK_CONTRACT} refreshKey={0} />,
    );

    await waitFor(() => {
      const countText =
        screen.getByText(/Showing/i).textContent || "";
      expect(countText).toContain("1");
    });

    // Search matching — still 1
    const searchInput = screen.getByPlaceholderText(
      /Search by address/i,
    );
    fireEvent.change(searchInput, { target: { value: "GONLY" } });

    await waitFor(
      () => {
        const countText =
          screen.getByText(/Showing/i).textContent || "";
        expect(countText).toContain("1");
      },
      { timeout: 500 },
    );

    // Search non-matching — 0
    fireEvent.change(searchInput, {
      target: { value: "ZZZZZZZZ" },
    });

    await waitFor(
      () => {
        expect(
          screen.getByText(/No collaborators match/i),
        ).toBeTruthy();
      },
      { timeout: 500 },
    );
  });

  /* ── Payment status filter ───────────────────────────────────────────── */
  it("supports payment-status filter dropdown", async () => {
    setup();
    await waitFor(() => {
      const countText =
        screen.getByText(/Showing/i).textContent || "";
      expect(countText).toContain("5");
    });

    const statusSelect = screen.getByLabelText(
      /Filter by payment status/i,
    );
    expect(statusSelect).toBeTruthy();

    // Default is "All statuses"
    expect(statusSelect).toHaveValue("all");

    // Switch to "Paid" — with no analytics data (no payments) it shows 0
    fireEvent.change(statusSelect, { target: { value: "paid" } });

    await waitFor(() => {
      // No one is marked as paid (analytics returned empty stats)
      expect(
        screen.getByText(/No collaborators match/i),
      ).toBeTruthy();
    });
  });
});

/* ── Allocation chart integration (#719) ──────────────────────────────── */

const COLLAB1 = "GA7E6YDRQKJ2JNOG27UPSCQ3FQ6U4X3QQGJKHNGF23T7QCI2FM6E3W2P";
const COLLAB2 = "GBOW474QUGZMHVHF6YDRQKJ2JNOG27UPUCY4FU7E6UDBOKBZJJNWYPSI";

describe("CollaboratorTable allocation chart", () => {
  it("renders nothing when contractId is empty", () => {
    const { container } = render(
      <CollaboratorTable contractId="" refreshKey={0} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("shows loading state, then renders the allocation chart and table with matching percentages", async () => {
    setup([
      { address: COLLAB1, basisPoints: 6500 },
      { address: COLLAB2, basisPoints: 3500 },
    ]);

    expect(
      screen.getAllByText(/Loading collaborators/i).length,
    ).toBeGreaterThan(0);

    await waitFor(() =>
      expect(
        screen.getByTestId("collaborator-allocation-chart"),
      ).toBeInTheDocument(),
    );

    // The exact percentage appears both in the chart legend and the table —
    // they must never disagree, since both are derived from the same
    // basisPoints values passed straight through without re-rounding.
    expect(screen.getAllByText("65.00%").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("35.00%").length).toBeGreaterThanOrEqual(2);
  });

  it("shows an error state when the API call fails", async () => {
    mockGetCollaborators.mockRejectedValue(new Error("network down"));

    render(<CollaboratorTable contractId={MOCK_CONTRACT} refreshKey={0} />);

    await waitFor(() =>
      expect(screen.getByText("network down")).toBeInTheDocument(),
    );
  });

  it("shows an empty state and no chart when there are no collaborators", async () => {
    setup([]);

    await waitFor(() =>
      expect(screen.getByText(/No collaborators found/i)).toBeInTheDocument(),
    );
    expect(
      screen.queryByTestId("collaborator-allocation-chart"),
    ).not.toBeInTheDocument();
  });

  it("refetches when refreshKey changes", async () => {
    mockGetCollaborators.mockResolvedValue([
      { address: COLLAB1, basisPoints: 10000 },
    ]);

    const { rerender } = render(
      <CollaboratorTable contractId={MOCK_CONTRACT} refreshKey={0} />,
    );
    await waitFor(() => expect(mockGetCollaborators).toHaveBeenCalledTimes(1));

    rerender(<CollaboratorTable contractId={MOCK_CONTRACT} refreshKey={1} />);
    await waitFor(() => expect(mockGetCollaborators).toHaveBeenCalledTimes(2));
  });

  /* ── Multi-format Export (#896) ────────────────────────────────────────── */
  describe("Multi-format Export (#896)", () => {
    it("renders export button and toggles dropdown menu", async () => {
      setup();
      await waitFor(() => expect(screen.getByText(/Showing/i)).toBeInTheDocument());

      const exportBtn = screen.getByRole("button", { name: /Export collaborator data/i });
      expect(exportBtn).toBeInTheDocument();
      expect(screen.queryByTestId("export-collaborators-csv")).not.toBeInTheDocument();

      // Click to open menu
      fireEvent.click(exportBtn);
      expect(screen.getByTestId("export-collaborators-csv")).toBeInTheDocument();
      expect(screen.getByTestId("export-collaborators-json")).toBeInTheDocument();
    });

    it("triggers CSV and JSON downloads when clicking menu options", async () => {
      setup();
      await waitFor(() => expect(screen.getByText(/Showing/i)).toBeInTheDocument());

      const exportBtn = screen.getByRole("button", { name: /Export collaborator data/i });
      fireEvent.click(exportBtn);

      const csvOption = screen.getByTestId("export-collaborators-csv");
      fireEvent.click(csvOption);

      // Menu closes after click
      expect(screen.queryByTestId("export-collaborators-csv")).not.toBeInTheDocument();

      // Open and click JSON
      fireEvent.click(exportBtn);
      const jsonOption = screen.getByTestId("export-collaborators-json");
      fireEvent.click(jsonOption);
      expect(screen.queryByTestId("export-collaborators-json")).not.toBeInTheDocument();
    });

    it("updates export button text when filters are active", async () => {
      setup();
      await waitFor(() => expect(screen.getByText(/Showing/i)).toBeInTheDocument());

      // Filter by share > 10%
      const shareSelect = screen.getByLabelText("Filter by share percentage");
      fireEvent.change(shareSelect, { target: { value: "gt10" } });

      await waitFor(() => {
        const exportBtn = screen.getByRole("button", { name: /Export collaborator data/i });
        expect(exportBtn.textContent).toContain("Export (2)");
      });
    });
  });
});


