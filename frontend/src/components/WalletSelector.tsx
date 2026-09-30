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
    icon: '🦋',
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
    id: 'walletconnect',
    name: 'WalletConnect',
    description: 'Scan QR code to connect mobile wallet.',
    icon: '📱',
    type: 'walletconnect',
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
    icon: '🔒',
    type: 'trezor',
    hardware: true,
  },
];

interface WalletSelectorProps {
  onSelect?: (walletId: string) => void;
  onClose?: () => void;
}

export const WalletSelector: React.FC<WalletSelectorProps> = ({ onSelect, onClose }) => {
  const { connect, error, clearError, activeWalletId, disconnect } = useWallet();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [hardwareWallet, setHardwareWallet] = useState<WalletOption | null>(null);

  const handleConnect = async (wallet: WalletOption) => {
    clearError();
    if (wallet.hardware) {
      setHardwareWallet(wallet);
    }
    setPendingId(wallet.id);
    try {
      await connect(wallet.id);
      onSelect?.(wallet.id);
      onClose?.();
    } catch {
      // Error is handled by context
    } finally {
      setPendingId(null);
      setHardwareWallet(null);
    }
  };

  const handleSwitch = async (walletId: string) => {
    await disconnect();
    const wallet = WALLET_OPTIONS.find((w) => w.id === walletId);
    if (wallet) {
      await handleConnect(wallet);
    }
  };

  return (
    <div className="wallet-selector-container">
      <h2>Connect Wallet</h2>
      {error && (
        <div className="error-message" role="alert">
          {error}
          <button onClick={clearError} className="close-error" aria-label="Dismiss error">
            ×
          </button>
        </div>
      )}

      {hardwareWallet && (
        <div className="hardware-confirmation" role="dialog" aria-label="Hardware wallet confirmation">
          <p>
            Please confirm the connection on your {hardwareWallet.name} device.
          </p>
          <p>Make sure your device is unlocked and the app is open.</p>
        </div>
      )}

      <div className="wallet-options-grid">
        {WALLET_OPTIONS.map((wallet) => {
          const isActive = activeWalletId === wallet.id;
          const isPending = pendingId === wallet.id;
          return (
            <button
              key={wallet.id}
              onClick={() => (isActive ? handleSwitch(wallet.id) : handleConnect(wallet))}
              className={`wallet-option-btn${isActive ? ' active' : ''}${isPending ? ' pending' : ''}`}
              aria-label={`Connect with ${wallet.name}`}
              aria-pressed={isActive}
              disabled={isPending}
            >
              <span className="wallet-icon" aria-hidden="true">
                {wallet.icon}
              </span>
              <div className="wallet-info">
                <span className="wallet-name">{wallet.name}</span>
                <span className="wallet-description">{wallet.description}</span>
              </div>
              {isActive && <span className="wallet-badge">Active</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
};

export default WalletSelector;
