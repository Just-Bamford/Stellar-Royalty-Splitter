import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AddressCopy } from "./AddressCopy";
import { NotificationProvider } from "../context/NotificationContext";

// A structurally valid G-address and C-address
const G_ADDR = "G" + "A".repeat(55);
const C_ADDR = "C" + "A".repeat(55);

// Wrap with NotificationProvider since AddressCopy calls useNotification
function Wrapper({ children }: { children: React.ReactNode }) {
  return <NotificationProvider>{children}</NotificationProvider>;
}

function renderAddressCopy(props: Partial<React.ComponentProps<typeof AddressCopy>> = {}) {
  return render(
    <Wrapper>
      <AddressCopy address={G_ADDR} {...props} />
    </Wrapper>,
  );
}

// ── Clipboard mock ─────────────────────────────────────────────────────────
const mockWriteText = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  vi.restoreAllMocks();
  Object.assign(navigator, {
    clipboard: { writeText: mockWriteText },
  });
});

// ── Rendering ──────────────────────────────────────────────────────────────

describe("AddressCopy — rendering", () => {
  it("renders without crashing for a G-address", () => {
    renderAddressCopy({ address: G_ADDR });
    expect(screen.getByLabelText(/Address: /i)).toBeTruthy();
  });

  it("renders without crashing for a C-address", () => {
    renderAddressCopy({ address: C_ADDR });
    expect(screen.getByLabelText(/Address: /i)).toBeTruthy();
  });

  it("returns null when address is empty", () => {
    const { container } = renderAddressCopy({ address: "" });
    expect(container.firstChild).toBeNull();
  });

  it("shows truncated address by default (first-4 and last-4)", () => {
    renderAddressCopy({ address: G_ADDR, truncateChars: 4 });
    expect(screen.getByText(G_ADDR.slice(0, 4))).toBeTruthy();
    expect(screen.getByText(G_ADDR.slice(-4))).toBeTruthy();
  });

  it("shows invalid badge for a malformed address", () => {
    renderAddressCopy({ address: "NOT_VALID" });
    expect(screen.getByTitle("Invalid Stellar address format")).toBeTruthy();
  });

  it("does not show invalid badge for a valid address", () => {
    renderAddressCopy({ address: G_ADDR });
    expect(screen.queryByTitle("Invalid Stellar address format")).toBeNull();
  });
});

// ── Copy button ────────────────────────────────────────────────────────────

describe("AddressCopy — copy button", () => {
  it("copy button is present", () => {
    renderAddressCopy();
    expect(screen.getByRole("button", { name: /copy address/i })).toBeTruthy();
  });

  it("calls clipboard.writeText with the full address on click", async () => {
    renderAddressCopy({ address: G_ADDR });
    await userEvent.click(screen.getByRole("button", { name: /copy address/i }));
    expect(mockWriteText).toHaveBeenCalledWith(G_ADDR);
  });

  it("button label changes to 'Copied to clipboard' after click", async () => {
    renderAddressCopy({ address: G_ADDR });
    const btn = screen.getByRole("button", { name: /copy address/i });
    await userEvent.click(btn);
    await waitFor(() =>
      expect(btn.getAttribute("aria-label")).toBe("Copied to clipboard"),
    );
  });

  it("shows label prop in copy aria-label", () => {
    renderAddressCopy({ address: G_ADDR, label: "wallet" });
    expect(screen.getByRole("button", { name: /copy wallet/i })).toBeTruthy();
  });
});

// ── Verification UI ────────────────────────────────────────────────────────

describe("AddressCopy — verification UI (hover)", () => {
  it("shows full address on mouseEnter", async () => {
    renderAddressCopy({ address: G_ADDR });
    const addrSpan = screen.getByLabelText(/Address:/i);
    fireEvent.mouseEnter(addrSpan);
    await waitFor(() => expect(screen.getByText(G_ADDR)).toBeTruthy());
  });

  it("reverts to truncated on mouseLeave", async () => {
    renderAddressCopy({ address: G_ADDR });
    const addrSpan = screen.getByLabelText(/Address:/i);
    fireEvent.mouseEnter(addrSpan);
    fireEvent.mouseLeave(addrSpan);
    await waitFor(() => expect(screen.queryByText(G_ADDR)).toBeNull());
  });
});

// ── QR code ────────────────────────────────────────────────────────────────

describe("AddressCopy — QR modal", () => {
  it("QR button is present by default for valid address", () => {
    renderAddressCopy({ address: G_ADDR });
    expect(screen.getByRole("button", { name: /show qr code/i })).toBeTruthy();
  });

  it("QR button is hidden when showQr=false", () => {
    renderAddressCopy({ address: G_ADDR, showQr: false });
    expect(screen.queryByRole("button", { name: /show qr code/i })).toBeNull();
  });

  it("opens QR modal on click", async () => {
    renderAddressCopy({ address: G_ADDR });
    await userEvent.click(screen.getByRole("button", { name: /show qr code/i }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByLabelText(/QR code for/i)).toBeTruthy();
  });

  it("closes QR modal via close button", async () => {
    renderAddressCopy({ address: G_ADDR });
    await userEvent.click(screen.getByRole("button", { name: /show qr code/i }));
    await userEvent.click(screen.getByRole("button", { name: /close qr modal/i }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes QR modal on Escape key", async () => {
    renderAddressCopy({ address: G_ADDR });
    await userEvent.click(screen.getByRole("button", { name: /show qr code/i }));
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("QR button is hidden for invalid address", () => {
    renderAddressCopy({ address: "INVALID", showQr: true });
    expect(screen.queryByRole("button", { name: /show qr code/i })).toBeNull();
  });
});

// ── Paste validation ───────────────────────────────────────────────────────

describe("AddressCopy — paste validation", () => {
  it("paste validator is hidden by default", () => {
    renderAddressCopy({ address: G_ADDR });
    expect(screen.queryByLabelText(/paste.*verify/i)).toBeNull();
  });

  it("shows paste validator when showPasteValidation=true", () => {
    renderAddressCopy({ address: G_ADDR, showPasteValidation: true });
    expect(screen.getByLabelText(/paste.*verify/i)).toBeTruthy();
  });

  it("shows 'matches' feedback when pasted address equals source", async () => {
    renderAddressCopy({ address: G_ADDR, showPasteValidation: true });
    const input = screen.getByLabelText(/paste.*verify/i);
    await userEvent.type(input, G_ADDR);
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain("matches"),
    );
  });

  it("shows invalid feedback for non-Stellar input", async () => {
    renderAddressCopy({ address: G_ADDR, showPasteValidation: true });
    const input = screen.getByLabelText(/paste.*verify/i);
    await userEvent.type(input, "not-an-address");
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain("valid Stellar"),
    );
  });

  it("shows mismatch feedback for a valid but different address", async () => {
    const OTHER = "G" + "B".repeat(55);
    renderAddressCopy({ address: G_ADDR, showPasteValidation: true });
    const input = screen.getByLabelText(/paste.*verify/i);
    await userEvent.type(input, OTHER);
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain("does not match"),
    );
  });
});
