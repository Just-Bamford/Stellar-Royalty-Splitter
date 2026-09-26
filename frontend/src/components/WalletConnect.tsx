import { useState } from "react";
import { useNetwork } from "../context/NetworkContext";
import { useWallet } from "../context/WalletContext";
import WalletSelector from "./WalletSelector";

interface Props {
  walletAddress: string | null;
  onConnect: (address: string) => void;
  onDisconnect?: () => void;
}

export default function WalletConnect({ walletAddress, onConnect, onDisconnect }: Props) {
  const { refreshWalletNetwork } = useNetwork();
  const { connect, disconnect, error, isLoading, selectedWallet, setSelectedWallet } = useWallet();
  const [showSelector, setShowSelector] = useState(false);

  const handleConnect = async () => {
    if (!selectedWallet) {
      setShowSelector(true);
      return;
    }

    try {
      const address = await connect(selectedWallet);
      if (address) {
        onConnect(address);
        await refreshWalletNetwork();
        setShowSelector(false);
      }
    } catch (err) {
      // Error is handled in context, but we can ensure UI state is clean
      console.error("Connection failed", err);
    }
  };

  const handleDisconnect = () => {
    disconnect();
    onDisconnect?.();
  };

  const handleSelectWallet = (walletId: string) => {
    setSelectedWallet(walletId);
    // Auto-connect if a wallet is selected
    handleConnect();
  };

  return (
    <div className="card">
      <div className="wallet-row">
        <span className="badge">Wallet</span>
        {walletAddress ? (
          <>
            <button
              className="wallet-addr"
              onClick={() => navigator.clipboard.writeText(walletAddress)}
              title="Copy address"
            >
              {walletAddress.slice(0, 6)}...{walletAddress.slice(-4)}
              <span className="copy-hint"> 📋</span>
            </button>
            <button className="btn-secondary" onClick={handleDisconnect}>
              Disconnect
            </button>
          </>
        ) : (
          <div className="connect-actions">
            <button
              className="btn-primary"
              onClick={handleConnect}
              disabled={isLoading}
            >
              {isLoading ? "Connecting..." : "Connect Wallet"}
            </button>
            <button
              className="btn-text"
              onClick={() => setShowSelector(true)}
              disabled={isLoading}
            >
              Other Wallets
            </button>
          </div>
        )}
      </div>

      {error && (
        <div className="status error" role="alert">
          {error}
        </div>
      )}

      {showSelector && (
        <WalletSelector
          onSelect={handleSelectWallet}
          onClose={() => setShowSelector(false)}
        />
      )}
    </div>
  );
}