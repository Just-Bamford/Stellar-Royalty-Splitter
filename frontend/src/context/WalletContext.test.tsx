import { render, screen, waitFor, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import React from "react";
import { WalletProvider, useWallet } from "./WalletContext";
import * as walletAdapterModule from "../lib/wallet-adapter";

// Test consumer to inspect WalletContext state
function TestConsumer() {
  const { wallet, isLoading, error, connect } = useWallet();
  return (
    <div>
      <div data-testid="error-state">{error === null ? "null" : error}</div>
      <div data-testid="wallet-state">{wallet ? wallet.address : "disconnected"}</div>
      <div data-testid="loading-state">{isLoading ? "loading" : "idle"}</div>
      <button onClick={() => connect("freighter").catch(() => {})}>Connect</button>
    </div>
  );
}

describe("WalletContext (#1176)", () => {
  const originalGetItem = localStorage.getItem;
  const originalSetItem = localStorage.setItem;

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.getItem = originalGetItem;
    localStorage.setItem = originalSetItem;
  });

  it("initializes with error as null on mount", () => {
    render(
      <WalletProvider>
        <TestConsumer />
      </WalletProvider>
    );

    expect(screen.getByTestId("error-state")).toHaveTextContent("null");
    expect(screen.getByTestId("wallet-state")).toHaveTextContent("disconnected");
  });

  it("does not set error state when auto-connect fails (e.g. Freighter not installed)", async () => {
    localStorage.setItem("selectedWalletType", "freighter");

    const mockAdapter = {
      address: null,
      connect: vi.fn().mockRejectedValue(new Error("Freighter not installed")),
      disconnect: vi.fn(),
      signTransaction: vi.fn(),
    };
    vi.spyOn(walletAdapterModule, "getWalletAdapter").mockReturnValue(mockAdapter as any);

    render(
      <WalletProvider>
        <TestConsumer />
      </WalletProvider>
    );

    // Auto-connect runs in useEffect
    await waitFor(() => {
      expect(mockAdapter.connect).toHaveBeenCalled();
    });

    // Error must remain null — no error leaked before user interaction
    expect(screen.getByTestId("error-state")).toHaveTextContent("null");
  });

  it("still sets error when explicit connect() fails", async () => {
    const mockAdapter = {
      address: null,
      connect: vi.fn().mockRejectedValue(new Error("User rejected connection")),
      disconnect: vi.fn(),
      signTransaction: vi.fn(),
    };
    vi.spyOn(walletAdapterModule, "getWalletAdapter").mockReturnValue(mockAdapter as any);

    render(
      <WalletProvider>
        <TestConsumer />
      </WalletProvider>
    );

    expect(screen.getByTestId("error-state")).toHaveTextContent("null");

    await act(async () => {
      screen.getByRole("button", { name: /connect/i }).click();
    });

    await waitFor(() => {
      expect(screen.getByTestId("error-state")).toHaveTextContent("User rejected connection");
    });
  });
});
