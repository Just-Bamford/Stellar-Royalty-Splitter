import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { describe, it, expect, beforeEach, vi } from "vitest";
import WalletConnect from "./WalletConnect";

const mockRefreshWalletNetwork = vi.fn();
const mockConnect = vi.fn();
const mockDisconnect = vi.fn();
const mockSetSelectedWallet = vi.fn();

let mockWalletContext = {
  connect: mockConnect,
  disconnect: mockDisconnect,
  error: null as string | null,
  isLoading: false,
  selectedWallet: "freighter" as string | null,
  setSelectedWallet: mockSetSelectedWallet,
};

vi.mock("../context/NetworkContext", () => ({
  useNetwork: () => ({
    refreshWalletNetwork: mockRefreshWalletNetwork,
  }),
}));

vi.mock("../context/WalletContext", () => ({
  useWallet: () => mockWalletContext,
}));

const ADDRESS = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA";

beforeEach(() => {
  vi.clearAllMocks();
  mockWalletContext = {
    connect: mockConnect,
    disconnect: mockDisconnect,
    error: null,
    isLoading: false,
    selectedWallet: "freighter",
    setSelectedWallet: mockSetSelectedWallet,
  };
});

describe("WalletConnect Component", () => {
  it("renders connect button when not connected", () => {
    render(<WalletConnect walletAddress={null} onConnect={vi.fn()} />);
    expect(screen.getByRole("button", { name: /connect wallet/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /other wallets/i })).toBeInTheDocument();
  });

  it("handles connect when wallet is selected", async () => {
    mockConnect.mockResolvedValue(ADDRESS);
    const onConnect = vi.fn();

    render(<WalletConnect walletAddress={null} onConnect={onConnect} />);

    fireEvent.click(screen.getByRole("button", { name: /connect wallet/i }));

    await waitFor(() => {
      expect(mockConnect).toHaveBeenCalledWith("freighter");
      expect(onConnect).toHaveBeenCalledWith(ADDRESS);
      expect(mockRefreshWalletNetwork).toHaveBeenCalled();
    });
  });

  it("opens wallet selector when 'Other Wallets' is clicked", () => {
    render(<WalletConnect walletAddress={null} onConnect={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /other wallets/i }));

    expect(screen.getByText("Freighter")).toBeInTheDocument();
    expect(screen.getByText("MetaMask")).toBeInTheDocument();
  });

  it("opens wallet selector when connecting without a selected wallet", () => {
    mockWalletContext.selectedWallet = null;

    render(<WalletConnect walletAddress={null} onConnect={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /connect wallet/i }));

    expect(screen.getByText("Freighter")).toBeInTheDocument();
    expect(screen.getByText("MetaMask")).toBeInTheDocument();
  });

  it("displays truncated address and disconnect button when connected", () => {
    const onDisconnect = vi.fn();

    render(
      <WalletConnect
        walletAddress={ADDRESS}
        onConnect={vi.fn()}
        onDisconnect={onDisconnect}
      />,
    );

    expect(screen.getByText("GAAZI4...CWNA")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /disconnect/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /disconnect/i }));
    expect(mockDisconnect).toHaveBeenCalled();
    expect(onDisconnect).toHaveBeenCalled();
  });

  it("displays error message when context has error", () => {
    mockWalletContext.error = "User rejected transaction or connection";

    render(<WalletConnect walletAddress={null} onConnect={vi.fn()} />);

    expect(screen.getByRole("alert")).toHaveTextContent("User rejected transaction or connection");
  });

  it("disables connect button when loading", () => {
    mockWalletContext.isLoading = true;

    render(<WalletConnect walletAddress={null} onConnect={vi.fn()} />);

    expect(screen.getByRole("button", { name: /connecting.../i })).toBeDisabled();
  });
});
