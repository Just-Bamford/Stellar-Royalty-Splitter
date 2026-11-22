import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import ResaleHistory from "./ResaleHistory";

vi.mock("../hooks/queries/useSecondarySales", () => ({
  useSecondarySales: vi.fn(),
  useSecondaryDistributions: vi.fn(),
}));

import { useSecondarySales, useSecondaryDistributions } from "../hooks/queries/useSecondarySales";

const mockUseSecondarySales = useSecondarySales as unknown as ReturnType<typeof vi.fn>;
const mockUseSecondaryDistributions = useSecondaryDistributions as unknown as ReturnType<typeof vi.fn>;

describe("ResaleHistory Component (Issue #1425)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders TableSkeleton inside card resale-history when loading", () => {
    mockUseSecondarySales.mockReturnValue({
      data: undefined,
      isLoading: true,
    });
    mockUseSecondaryDistributions.mockReturnValue({
      data: undefined,
      isLoading: false,
    });

    const { container } = render(<ResaleHistory contractId="TEST_CONTRACT" />);

    // Heading must be preserved to prevent layout shift
    expect(screen.getByText("Resale & Royalty History")).toBeInTheDocument();

    // Plain text "<p>Loading resale history...</p>" must NOT be present
    expect(screen.queryByText("Loading resale history...")).not.toBeInTheDocument();

    // TableSkeleton should be rendered with role="status" and rows
    const skeleton = container.querySelector(".table-skeleton");
    expect(skeleton).toBeInTheDocument();
    expect(skeleton?.querySelectorAll(".table-skeleton-row")).toHaveLength(5);
  });

  it("renders table content when loading finishes", () => {
    mockUseSecondarySales.mockReturnValue({
      data: {
        sales: [
          {
            id: 1,
            nftId: "NFT_1234567890123456789",
            seller: "SELLER1",
            buyer: "BUYER1",
            newOwner: "OWNER_12345678",
            salePrice: 100,
            royaltyRate: 500,
            royaltyAmount: 5,
            timestamp: "2026-11-20T10:00:00Z",
            txHash: "HASH1",
          },
        ],
        total: 1,
      },
      isLoading: false,
    });
    mockUseSecondaryDistributions.mockReturnValue({
      data: {
        distributions: [],
        total: 0,
      },
      isLoading: false,
    });

    const { container } = render(<ResaleHistory contractId="TEST_CONTRACT" />);

    expect(screen.getByText("Resale & Royalty History")).toBeInTheDocument();
    expect(container.querySelector(".table-skeleton")).not.toBeInTheDocument();
    expect(screen.getByText(/NFT_123456789012/)).toBeInTheDocument();
  });
});
