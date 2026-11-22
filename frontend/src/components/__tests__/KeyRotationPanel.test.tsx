import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom";
import { KeyRotationPanel } from "../KeyRotationPanel";

describe("KeyRotationPanel Secret Key Validation (#1384)", () => {
  const validSecretKey = "SBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
  const adminToken = "test-token";

  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes("/api/admin/key-status")) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              configured: true,
              publicKey: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
              lastRotationAt: new Date().toISOString(),
              lastRotationSource: "secretKey",
              secretsProvider: "none",
              encryptionEnabled: false,
            }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ publicKey: "G...", rotatedAt: "", source: "" }),
      });
    });
  });

  it("disables rotate button for empty or malformed secret key inputs", async () => {
    render(<KeyRotationPanel adminToken={adminToken} />);

    await waitFor(() => {
      expect(screen.getByText("Configured")).toBeInTheDocument();
    });

    const rotateBtn = screen.getByRole("button", { name: /Rotate Key/i });
    expect(rotateBtn).toBeDisabled();

    const input = screen.getByLabelText("New Stellar secret key");

    // "S" only -> disabled
    fireEvent.change(input, { target: { value: "S" } });
    expect(rotateBtn).toBeDisabled();

    // "Shello" -> disabled
    fireEvent.change(input, { target: { value: "Shello" } });
    expect(rotateBtn).toBeDisabled();

    // 56 chars with invalid Base32 (e.g. contains 8 or 9) -> disabled
    fireEvent.change(input, {
      target: { value: "S8989898989898989898989898989898989898989898989898989898" },
    });
    expect(rotateBtn).toBeDisabled();
  });

  it("enables rotate button when secret key is a valid 56-character Stellar Strkey", async () => {
    render(<KeyRotationPanel adminToken={adminToken} />);

    await waitFor(() => {
      expect(screen.getByText("Configured")).toBeInTheDocument();
    });

    const rotateBtn = screen.getByRole("button", { name: /Rotate Key/i });
    const input = screen.getByLabelText("New Stellar secret key");

    fireEvent.change(input, { target: { value: validSecretKey } });
    expect(rotateBtn).not.toBeDisabled();
  });

  it("enables rotate button for non-secretKey methods without requiring input", async () => {
    render(<KeyRotationPanel adminToken={adminToken} />);

    await waitFor(() => {
      expect(screen.getByText("Configured")).toBeInTheDocument();
    });

    const reloadFromFileTab = screen.getByRole("button", { name: /Reload from file/i });
    fireEvent.click(reloadFromFileTab);

    const rotateBtn = screen.getByRole("button", { name: /Rotate Key/i });
    expect(rotateBtn).not.toBeDisabled();
  });
});
