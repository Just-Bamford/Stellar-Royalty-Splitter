import { describe, expect, test, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { ContractAddress, truncateMiddle } from "./ContractAddress";

const VALID = "C" + "A".repeat(55); // valid Stellar C-address format
const INVALID = "not-a-contract";

describe("truncateMiddle", () => {
  test("keeps short values intact and middle-truncates long ones", () => {
    expect(truncateMiddle("CABC")).toBe("CABC");
    const out = truncateMiddle(VALID);
    expect(out).toContain("…");
    expect(out.startsWith("CAAAAAAA")).toBe(true);
    expect(out.endsWith("AAAAAA")).toBe(true);
    expect(out.length).toBeLessThan(VALID.length);
  });
});

describe("ContractAddress", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete (navigator as any).clipboard;
  });

  test("validates a well-formed address on mount and exposes the full address", () => {
    render(<ContractAddress address={VALID} />);
    expect(screen.getByText(/✓ Valid/)).toBeInTheDocument();
    // Full address available for verification via the title/aria-label tooltip.
    expect(screen.getByTitle(VALID)).toBeInTheDocument();
  });

  test("flags an invalid address format on mount", () => {
    render(<ContractAddress address={INVALID} />);
    expect(screen.getByText(/⚠ Invalid/)).toBeInTheDocument();
  });

  test("copies the address and shows a toast confirmation", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    (navigator as any).clipboard = { writeText };

    render(<ContractAddress address={VALID} label="contract ID" />);
    fireEvent.click(screen.getByRole("button", { name: /Copy contract ID/i }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(VALID));
    expect(await screen.findByText(/Address copied to clipboard/i)).toBeInTheDocument();
  });

  test("opens a QR modal that contains the full address", () => {
    render(<ContractAddress address={VALID} />);
    fireEvent.click(screen.getByRole("button", { name: /Show QR code/i }));

    const dialog = screen.getByRole("dialog", { name: /QR code/i });
    expect(dialog).toBeInTheDocument();
    // Full address shown under the QR for manual verification.
    expect(within(dialog).getByText(VALID)).toBeInTheDocument();
  });
});
