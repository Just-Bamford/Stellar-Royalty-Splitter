import { describe, expect, test, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import WalletConnect from "./WalletConnect";

const VALID_WALLET = "GABCDEFGHIJKLMNOPQRSTUVWXYZ23456789ABCDEFGH";

describe("WalletConnect", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete (window as any).freighter;
    delete (navigator as any).clipboard;
    localStorage.clear();
  });

  test("shows install prompt and disables connect button when Freighter is unavailable", () => {
    render(<WalletConnect walletAddress={null} onConnect={vi.fn()} />);

    expect(screen.getByRole("button", { name: /Connect Freighter/i })).toBeDisabled();
    expect(screen.getByText(/Freighter wallet not found/i)).toBeInTheDocument();
  });

  test("calls onConnect when Freighter requestAccess resolves", async () => {
    const onConnect = vi.fn();
    (window as any).freighter = {
      requestAccess: vi.fn().mockResolvedValue({ address: VALID_WALLET }),
    };

    render(<WalletConnect walletAddress={null} onConnect={onConnect} />);
    fireEvent.click(screen.getByRole("button", { name: /Connect Freighter/i }));

    await waitFor(() => expect(onConnect).toHaveBeenCalledWith(VALID_WALLET));
  });

  test("disconnect clears localStorage and calls onDisconnect", () => {
    const onDisconnect = vi.fn();
    localStorage.setItem("lastWalletAddress", VALID_WALLET);
    localStorage.setItem("freighter_connected", "true");

    render(<WalletConnect walletAddress={VALID_WALLET} onConnect={vi.fn()} onDisconnect={onDisconnect} />);
    fireEvent.click(screen.getByRole("button", { name: /Disconnect/i }));

    expect(onDisconnect).toHaveBeenCalled();
    expect(localStorage.getItem("lastWalletAddress")).toBeNull();
    expect(localStorage.getItem("freighter_connected")).toBeNull();
  });

  test("copies the connected wallet address to clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    (navigator as any).clipboard = { writeText };

    render(<WalletConnect walletAddress={VALID_WALLET} onConnect={vi.fn()} />);
    fireEvent.click(screen.getByTitle(/Copy address/i));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(VALID_WALLET));
    expect(await screen.findByText(/✓/)).toBeInTheDocument();
  });
});
