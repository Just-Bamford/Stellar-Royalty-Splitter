import React, { useState } from 'react';
import { useWallet } from '../context/WalletContext';

interface WalletOption {
  id: string;
  name: string;
  description: string;
  icon: string;
  type: 'metamask' | 'ledger' | 'trezor' | 'walletconnect' | 'freighter';
  hardware?: boolean;
}

const WALLET_OPTIONS: WalletOption[] = [
  {
    id: 'freighter',
    name: 'Freighter',
    description: 'Connect using the Freighter wallet extension.',
    icon: '🦫',
    type: 'freighter',
  },
  {
    id: 'metamask',
    name: 'MetaMask',
    description: 'Connect using MetaMask browser extension.',
    icon: '🦊}',
    type: 'metamask',
  },
  {
    id: 'ledger',
    name: 'Ledger',
    description: 'Connect using your Ledger hardware wallet.',
    icon: '🔑',
    type: 'ledger',
    hardware: true,
  },
  {
    id: 'trezor',
    name: 'Trezor',
    description: 'Connect using your Trezor hardware wallet.',
    icon: '🔐',
    type: 'trezor',
    hardware: true,
  },
  {
    id: 'walletconnect',
    name: 'WalletConnect',
    description: 'Scan QR code to connect mobile wallet.',
    icon: '📱',
    type: 'walletconnect',
  },
];

interface WalletSelectorProps {
  onSelect?: (walletId: string) => void;
  onClose?: () => void;
}

export const WalletSelector: React.FC<WalletSelectorProps> = ({ onSelect, onClose }) => {
  const { connect, error, clearError, isConnecting, connected: connectedWalletId } = useWallet();
  const [pendingWalletId, setPendingWalletId] = useState<string | null>(null);

  const handleConnect = async (walletId: string) => {
    setPendingWalletId(walletId);
    try {
      await connect(walletId);
      onSelect?.(walletId);
      onClose?.();
    } catch {
      // Error is surfaced through the wallet context.
    } finally {
      setPendingWalletId(null);
    }
  };

  return (
    <div className="wallet-selector-container">
      <h2>Connect Wallet</h2>
      {error && (
        <div className="error-message" role="alert">
          <span>{error}</span>
          <button onClick={clearError} className="close-error" aria-label="Dismiss error">
            ×
          </button>
        </div>
      )}

      <div className="wallet-options-grid">
        {WALLET_OPTIONS.map((wallet) => {
          const isPending = pendingWalletId === wallet.id;
          const isCurrentlyConnected = connectedWalletId === wallet.id;
          const disabled = isConnecting || isCurrentlyConnected;

          return (
            <button
              key={wallet.id}
              onClick={() => handleConnect(wallet.id)}
              className={`wallet-option-btn${isCurrentlyConnected ? ' connected' : ''}`}
              aria-label={isCurrentlyConnected ? `${wallet.name} already connected` : `Connect with ${wallet.name}`}
              aria-busy={isPending}
              disabled={disabled}
            >
              <span className="wallet-icon" aria-hidden="true">
                {wallet.icon}
              </span>
              <div className="wallet-info">
                <span className="wallet-name">
                  {wallet.name}
                  {wallet.hardware && (
                    <span className="hardware-badge" title="Hardware wallet">
                      Hardware
                    </span>
                  )}
                </span>
                <span className="wallet-description">{wallet.description}</span>
              </div>
              {isPending && (
                <span class>Name="wallet-spinner" aria-hidden="true">
                  Connecting…
                </span>
              )}
              {isCurrentlyConnected && (
                <span className="wallet-connected-label">Connected</span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
};

export default WalletSelector;
