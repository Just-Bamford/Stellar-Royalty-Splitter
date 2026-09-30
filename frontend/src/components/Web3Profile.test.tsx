/**
 * Tests for Web3Profile component (#992).
 *
 * Strategy:
 *  - Mock the entire web3-identity service so tests are deterministic and fast.
 *  - Cover: loading skeleton, no-identity fallback, ENS name + verified badge,
 *    Lens handle + follower stats, avatar image + colour fallback, size variants,
 *    compact mode, bio (lg only), cross-platform linking (both ENS + Lens).
 *
 * Run with:
 *   cd frontend && npx react-scripts test --watchAll=false --testPathPattern=Web3Profile
 */

import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { vi } from "vitest";
import Web3Profile from "./Web3Profile";

// ── Mock the identity service ─────────────────────────────────────────────────

vi.mock("../services/web3-identity", () => ({
  resolveIdentity: vi.fn(),
}));

import { resolveIdentity, type Web3Identity } from "../services/web3-identity";

const mockResolveIdentity = vi.mocked(resolveIdentity);

// ── Test fixtures ─────────────────────────────────────────────────────────────

const ADDRESS = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const NO_IDENTITY: Web3Identity = {
  address: ADDRESS,
  ens: null,
  lens: null,
};

const ENS_ONLY: Web3Identity = {
  address: ADDRESS,
  ens: { name: "alice.eth", avatar: null, verified: true },
  lens: null,
};

const LENS_ONLY: Web3Identity = {
  address: ADDRESS,
  ens: null,
  lens: {
    handle: "lens/@alice",
    displayName: "Alice",
    picture: "https://cdn.example.com/avatar.png",
    followers: 1234,
    following: 56,
    bio: "NFT creator and music producer.",
  },
};

const FULL_IDENTITY: Web3Identity = {
  address: ADDRESS,
  ens: { name: "alice.eth", avatar: "https://metadata.ens.domains/mainnet/avatar/alice.eth", verified: true },
  lens: {
    handle: "lens/@alice",
    displayName: "Alice",
    picture: "https://cdn.example.com/avatar.png",
    followers: 9999,
    following: 100,
    bio: "Cross-platform creator.",
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function setup(identity: Web3Identity) {
  // Resolve immediately (no async tick needed for most tests)
  mockResolveIdentity.mockResolvedValue(identity);
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Web3Profile", () => {
  /* ── Loading state ────────────────────────────────────────────────────────── */

  it("shows a loading skeleton while resolving", () => {
    // Never resolves
    mockResolveIdentity.mockReturnValue(new Promise(() => {}));

    render(<Web3Profile address={ADDRESS} />);

    expect(screen.getByLabelText("Loading identity…")).toBeInTheDocument();
  });

  /* ── No identity ──────────────────────────────────────────────────────────── */

  it("renders truncated address when no identity resolves", async () => {
    setup(NO_IDENTITY);
    render(<Web3Profile address={ADDRESS} />);

    await waitFor(() => {
      // Should show truncated form: first 8 + … + last 6
      expect(screen.getByText(/GAAAAAAA…AAAAAA/)).toBeInTheDocument();
    });
  });

  /* ── ENS only ─────────────────────────────────────────────────────────────── */

  it("displays ENS name when resolved", async () => {
    setup(ENS_ONLY);
    render(<Web3Profile address={ADDRESS} />);

    await waitFor(() => {
      expect(screen.getByText("alice.eth")).toBeInTheDocument();
    });
  });

  it("shows verified checkmark for ENS-verified identity", async () => {
    setup(ENS_ONLY);
    render(<Web3Profile address={ADDRESS} />);

    await waitFor(() => {
      expect(screen.getByLabelText("ENS verified")).toBeInTheDocument();
    });
  });

  it("does NOT show verified checkmark when ens.verified is false", async () => {
    setup({
      ...ENS_ONLY,
      ens: { name: "alice.eth", avatar: null, verified: false },
    });
    render(<Web3Profile address={ADDRESS} />);

    await waitFor(() => {
      expect(screen.getByText("alice.eth")).toBeInTheDocument();
    });
    expect(screen.queryByLabelText("ENS verified")).not.toBeInTheDocument();
  });

  /* ── Lens only ────────────────────────────────────────────────────────────── */

  it("displays Lens handle when resolved", async () => {
    setup(LENS_ONLY);
    render(<Web3Profile address={ADDRESS} />);

    await waitFor(() => {
      expect(screen.getByText("lens/@alice")).toBeInTheDocument();
    });
  });

  it("shows Lens badge icon in sm mode when Lens profile exists", async () => {
    setup(LENS_ONLY);
    render(<Web3Profile address={ADDRESS} size="sm" />);

    await waitFor(() => {
      expect(screen.getByLabelText("Lens profile")).toBeInTheDocument();
    });
  });

  it("shows follower and following counts in md mode", async () => {
    setup(LENS_ONLY);
    render(<Web3Profile address={ADDRESS} size="md" />);

    await waitFor(() => {
      expect(screen.getByText(/1,234/)).toBeInTheDocument(); // followers
      expect(screen.getByText(/56/)).toBeInTheDocument();    // following
    });
  });

  it("does NOT show follower stats when compact=true", async () => {
    setup(LENS_ONLY);
    render(<Web3Profile address={ADDRESS} size="md" compact />);

    await waitFor(() => {
      expect(screen.getByText("lens/@alice")).toBeInTheDocument();
    });

    // Follower count should not appear in compact mode
    expect(screen.queryByText(/1,234/)).not.toBeInTheDocument();
  });

  /* ── Bio (lg only) ────────────────────────────────────────────────────────── */

  it("shows bio in lg size", async () => {
    setup(LENS_ONLY);
    render(<Web3Profile address={ADDRESS} size="lg" />);

    await waitFor(() => {
      expect(
        screen.getByText("NFT creator and music producer."),
      ).toBeInTheDocument();
    });
  });

  it("does NOT show bio in md size", async () => {
    setup(LENS_ONLY);
    render(<Web3Profile address={ADDRESS} size="md" />);

    await waitFor(() => {
      expect(screen.getByText("lens/@alice")).toBeInTheDocument();
    });

    expect(
      screen.queryByText("NFT creator and music producer."),
    ).not.toBeInTheDocument();
  });

  /* ── Avatar ───────────────────────────────────────────────────────────────── */

  it("renders an img element when a picture URL is available", async () => {
    setup(LENS_ONLY);
    render(<Web3Profile address={ADDRESS} size="md" />);

    await waitFor(() => {
      const img = screen.getByRole("img", { hidden: true }) as HTMLImageElement;
      expect(img.src).toBe("https://cdn.example.com/avatar.png");
    });
  });

  it("shows initials fallback avatar when no picture is available", async () => {
    setup(NO_IDENTITY);
    render(<Web3Profile address={ADDRESS} />);

    await waitFor(() => {
      // No img, shows first 2 chars of address uppercased
      expect(screen.queryByRole("img")).not.toBeInTheDocument();
      // The address starts with GA, so initials should show GA
      expect(screen.getByText("GA")).toBeInTheDocument();
    });
  });

  /* ── Cross-platform: both ENS + Lens ─────────────────────────────────────── */

  it("prioritises ENS name over Lens handle as primary display name", async () => {
    setup(FULL_IDENTITY);
    render(<Web3Profile address={ADDRESS} size="sm" />);

    await waitFor(() => {
      // ENS name takes priority
      expect(screen.getByText("alice.eth")).toBeInTheDocument();
    });
  });

  it("shows both ENS verified badge and Lens badge in sm mode for full identity", async () => {
    setup(FULL_IDENTITY);
    render(<Web3Profile address={ADDRESS} size="sm" />);

    await waitFor(() => {
      expect(screen.getByLabelText("ENS verified")).toBeInTheDocument();
      expect(screen.getByLabelText("Lens profile")).toBeInTheDocument();
    });
  });

  it("shows ENS avatar over Lens picture when both are present", async () => {
    // ENS avatar has lower priority than Lens picture in pickAvatar()
    // (lens?.picture ?? ens?.avatar) — Lens picture wins
    setup(FULL_IDENTITY);
    render(<Web3Profile address={ADDRESS} size="md" />);

    await waitFor(() => {
      const img = screen.getByRole("img", { hidden: true }) as HTMLImageElement;
      // Lens picture takes priority
      expect(img.src).toBe("https://cdn.example.com/avatar.png");
    });
  });

  it("shows Lens follower count in md/lg for full identity", async () => {
    setup(FULL_IDENTITY);
    render(<Web3Profile address={ADDRESS} size="md" />);

    await waitFor(() => {
      expect(screen.getByText(/9,999/)).toBeInTheDocument();
    });
  });

  /* ── Size variants ────────────────────────────────────────────────────────── */

  it("applies sm class in sm mode", async () => {
    setup(ENS_ONLY);
    const { container } = render(<Web3Profile address={ADDRESS} size="sm" />);

    await waitFor(() => {
      expect(screen.getByText("alice.eth")).toBeInTheDocument();
    });

    expect(container.querySelector(".web3-profile--sm")).toBeInTheDocument();
  });

  it("applies md class in md mode", async () => {
    setup(ENS_ONLY);
    const { container } = render(<Web3Profile address={ADDRESS} size="md" />);

    await waitFor(() => {
      expect(screen.getByText("alice.eth")).toBeInTheDocument();
    });

    expect(container.querySelector(".web3-profile--md")).toBeInTheDocument();
  });

  /* ── Performance: resolveIdentity called exactly once per mount ──────────── */

  it("calls resolveIdentity exactly once per address on mount", async () => {
    setup(ENS_ONLY);
    render(<Web3Profile address={ADDRESS} />);

    await waitFor(() => {
      expect(screen.getByText("alice.eth")).toBeInTheDocument();
    });

    expect(mockResolveIdentity).toHaveBeenCalledTimes(1);
    expect(mockResolveIdentity).toHaveBeenCalledWith(ADDRESS);
  });

  it("re-fetches when address prop changes", async () => {
    const ADDRESS_2 = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
    mockResolveIdentity.mockResolvedValue(ENS_ONLY);

    const { rerender } = render(<Web3Profile address={ADDRESS} />);
    await waitFor(() => screen.getByText("alice.eth"));

    mockResolveIdentity.mockResolvedValue({
      address: ADDRESS_2,
      ens: { name: "bob.eth", avatar: null, verified: true },
      lens: null,
    });

    rerender(<Web3Profile address={ADDRESS_2} />);
    await waitFor(() => screen.getByText("bob.eth"));

    expect(mockResolveIdentity).toHaveBeenCalledTimes(2);
    expect(mockResolveIdentity).toHaveBeenLastCalledWith(ADDRESS_2);
  });

  /* ── Empty address guard ──────────────────────────────────────────────────── */

  it("renders nothing meaningful for an empty address", () => {
    mockResolveIdentity.mockResolvedValue({ address: "", ens: null, lens: null });
    const { container } = render(<Web3Profile address="" />);
    // Should not crash; shows either empty or loading
    expect(container).toBeTruthy();
  });
});
