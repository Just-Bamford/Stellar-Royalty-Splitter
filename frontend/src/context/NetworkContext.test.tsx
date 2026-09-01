/**
 * Tests for wallet/app network mismatch detection (#663).
 */

import { describe, test, expect, afterEach, vi } from "vitest";
import { render, screen, act, waitFor, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom";
import {
  NetworkProvider,
  useNetwork,
  computeNetworkMismatch,
  FREIGHTER_NETWORK_NAMES,
} from "./NetworkContext";

describe("computeNetworkMismatch #663", () => {
  test("no wallet network detected yet — not a mismatch", () => {
    expect(computeNetworkMismatch(null, "testnet")).toBe(false);
    expect(computeNetworkMismatch(null, "mainnet")).toBe(false);
  });

  test("wallet network matches the configured app network", () => {
    expect(computeNetworkMismatch("TESTNET", "testnet")).toBe(false);
    expect(computeNetworkMismatch("PUBLIC", "mainnet")).toBe(false);
  });

  test("wallet network does not match the configured app network", () => {
    expect(computeNetworkMismatch("PUBLIC", "testnet")).toBe(true);
    expect(computeNetworkMismatch("TESTNET", "mainnet")).toBe(true);
  });

  test("unrecognized wallet network name is treated as a mismatch", () => {
    expect(computeNetworkMismatch("FUTURENET", "testnet")).toBe(true);
  });

  test("FREIGHTER_NETWORK_NAMES is the single source of truth for the mapping", () => {
    expect(FREIGHTER_NETWORK_NAMES.testnet).toBe("TESTNET");
    expect(FREIGHTER_NETWORK_NAMES.mainnet).toBe("PUBLIC");
  });
});

function TestConsumer() {
  const { network, walletNetworkName, networkMismatch, setNetwork } =
    useNetwork();
  return (
    <div>
      <span data-testid="app-network">{network}</span>
      <span data-testid="wallet-network">{walletNetworkName ?? "none"}</span>
      <span data-testid="mismatch">{String(networkMismatch)}</span>
      <button onClick={() => setNetwork("mainnet")}>switch-to-mainnet</button>
    </div>
  );
}

describe("NetworkProvider integration #663", () => {
  afterEach(() => {
    cleanup();
    // @ts-expect-error test-only cleanup of the injected wallet mock
    delete window.freighter;
    localStorage.clear();
  });

  test("no wallet installed — never reports a mismatch", async () => {
    render(
      <NetworkProvider>
        <TestConsumer />
      </NetworkProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("wallet-network").textContent).toBe("none");
    });
    expect(screen.getByTestId("mismatch").textContent).toBe("false");
  });

  test("wallet network matches the configured (default testnet) app network", async () => {
    window.freighter = {
      getNetwork: vi.fn(async () => ({ network: "TESTNET" })),
    } as unknown as Window["freighter"];

    render(
      <NetworkProvider>
        <TestConsumer />
      </NetworkProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("wallet-network").textContent).toBe("TESTNET");
    });
    expect(screen.getByTestId("mismatch").textContent).toBe("false");
  });

  test("wallet network mismatches the configured app network", async () => {
    window.freighter = {
      getNetwork: vi.fn(async () => ({ network: "PUBLIC" })),
    } as unknown as Window["freighter"];

    render(
      <NetworkProvider>
        <TestConsumer />
      </NetworkProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("wallet-network").textContent).toBe("PUBLIC");
    });
    expect(screen.getByTestId("mismatch").textContent).toBe("true");
  });

  test("switching the app network re-evaluates the mismatch without re-detecting the wallet", async () => {
    window.freighter = {
      getNetwork: vi.fn(async () => ({ network: "PUBLIC" })),
    } as unknown as Window["freighter"];

    render(
      <NetworkProvider>
        <TestConsumer />
      </NetworkProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("mismatch").textContent).toBe("true");
    });

    act(() => {
      screen.getByText("switch-to-mainnet").click();
    });

    await waitFor(() => {
      expect(screen.getByTestId("app-network").textContent).toBe("mainnet");
    });
    expect(screen.getByTestId("mismatch").textContent).toBe("false");
  });

  test("falls back to getNetworkDetails when getNetwork is unavailable", async () => {
    window.freighter = {
      getNetworkDetails: vi.fn(async () => ({ network: "TESTNET" })),
    } as unknown as Window["freighter"];

    render(
      <NetworkProvider>
        <TestConsumer />
      </NetworkProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("wallet-network").textContent).toBe("TESTNET");
    });
  });

  test("a rejected network lookup is treated as unknown, not a mismatch", async () => {
    window.freighter = {
      getNetwork: vi.fn(async () => {
        throw new Error("wallet locked");
      }),
    } as unknown as Window["freighter"];

    render(
      <NetworkProvider>
        <TestConsumer />
      </NetworkProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("wallet-network").textContent).toBe("none");
    });
    expect(screen.getByTestId("mismatch").textContent).toBe("false");
  });
});
