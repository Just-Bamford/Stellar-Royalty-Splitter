/**
 * Tests for WalletConnect session recovery (issue #697).
 *
 * Run with: cd frontend && npx react-scripts test --watchAll=false --testPathPattern=WalletConnect
 */

import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { describe, it, expect, beforeEach, vi } from "vitest";
import WalletConnect from "./WalletConnect";

vi.mock("../context/NetworkContext", () => ({
  useNetwork: () => ({
    refreshWalletNetwork: vi.fn(),
  }),
}));

const ADDRESS = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA";

function setFreighter(freighter: Partial<Window["freighter"]> | undefined) {
  Object.defineProperty(window, "freighter", {
    configurable: true,
    value: freighter,
  });
}

beforeEach(() => {
  localStorage.clear();
  setFreighter(undefined);
});

describe("WalletConnect session recovery", () => {
  it("silently restores a previously-connected session without prompting", async () => {
    localStorage.setItem("freighter_connected", "true");
    localStorage.setItem("lastWalletAddress", ADDRESS);
    const getAddress = vi.fn().mockResolvedValue({ address: ADDRESS });
    setFreighter({ getAddress });

    const onConnect = vi.fn();
    render(
      <WalletConnect
        walletAddress={null}
        onConnect={onConnect}
        onDisconnect={vi.fn()}
      />,
    );

    await waitFor(() => expect(onConnect).toHaveBeenCalledWith(ADDRESS));
    expect(getAddress).toHaveBeenCalled();
  });

  it("does not attempt a silent restore if no prior session was recorded", async () => {
    const getAddress = vi.fn().mockResolvedValue({ address: ADDRESS });
    setFreighter({ getAddress });

    const onConnect = vi.fn();
    render(
      <WalletConnect
        walletAddress={null}
        onConnect={onConnect}
        onDisconnect={vi.fn()}
      />,
    );

    await new Promise((r) => setTimeout(r, 0));
    expect(getAddress).not.toHaveBeenCalled();
    expect(onConnect).not.toHaveBeenCalled();
  });

  it("clears the stale session flag and shows a reconnect prompt when restore fails", async () => {
    localStorage.setItem("freighter_connected", "true");
    localStorage.setItem("lastWalletAddress", ADDRESS);
    const getAddress = vi.fn().mockRejectedValue(new Error("not authorized"));
    setFreighter({ getAddress });

    render(
      <WalletConnect
        walletAddress={null}
        onConnect={vi.fn()}
        onDisconnect={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(screen.getByText(/previous session expired/i)).toBeInTheDocument(),
    );
    expect(localStorage.getItem("freighter_connected")).toBeNull();
    expect(localStorage.getItem("lastWalletAddress")).toBeNull();
    expect(
      screen.getByRole("button", { name: /retry connection/i }),
    ).toBeInTheDocument();
  });

  it("persists the session after a successful manual connect", async () => {
    const requestAccess = vi.fn().mockResolvedValue({ address: ADDRESS });
    setFreighter({ requestAccess });

    const onConnect = vi.fn();
    render(
      <WalletConnect
        walletAddress={null}
        onConnect={onConnect}
        onDisconnect={vi.fn()}
      />,
    );

    screen.getByRole("button", { name: /connect freighter/i }).click();

    await waitFor(() => expect(onConnect).toHaveBeenCalledWith(ADDRESS));
    expect(localStorage.getItem("freighter_connected")).toBe("true");
    expect(localStorage.getItem("lastWalletAddress")).toBe(ADDRESS);
  });

  it("shows a readable error and keeps the connect button available when the user rejects the request", async () => {
    const requestAccess = vi
      .fn()
      .mockRejectedValue(new Error("User declined access"));
    setFreighter({ requestAccess });

    render(
      <WalletConnect
        walletAddress={null}
        onConnect={vi.fn()}
        onDisconnect={vi.fn()}
      />,
    );

    screen.getByRole("button", { name: /connect freighter/i }).click();

    await waitFor(() =>
      expect(screen.getByText(/connection rejected/i)).toBeInTheDocument(),
    );
    expect(
      screen.getByRole("button", { name: /retry connection/i }),
    ).toBeEnabled();
  });

  it("clears the persisted session on disconnect", () => {
    localStorage.setItem("freighter_connected", "true");
    localStorage.setItem("lastWalletAddress", ADDRESS);
    setFreighter({});

    const onDisconnect = vi.fn();
    render(
      <WalletConnect
        walletAddress={ADDRESS}
        onConnect={vi.fn()}
        onDisconnect={onDisconnect}
      />,
    );

    screen.getByRole("button", { name: /disconnect/i }).click();

    expect(onDisconnect).toHaveBeenCalled();
    expect(localStorage.getItem("freighter_connected")).toBeNull();
    expect(localStorage.getItem("lastWalletAddress")).toBeNull();
  });

  it("updates the connected address and persists it when Freighter reports an account change", () => {
    const onConnect = vi.fn();
    const handlers: Record<string, (data: { address: string }) => void> = {};
    setFreighter({
      getAddress: vi.fn().mockResolvedValue({ address: ADDRESS }),
      on: (event, handler) => {
        handlers[event] = handler;
      },
    });

    render(
      <WalletConnect
        walletAddress={ADDRESS}
        onConnect={onConnect}
        onDisconnect={vi.fn()}
      />,
    );

    const NEW_ADDRESS =
      "GBBZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNB";
    handlers.accountChanged({ address: NEW_ADDRESS });

    expect(onConnect).toHaveBeenCalledWith(NEW_ADDRESS);
    expect(localStorage.getItem("lastWalletAddress")).toBe(NEW_ADDRESS);
  });
});
