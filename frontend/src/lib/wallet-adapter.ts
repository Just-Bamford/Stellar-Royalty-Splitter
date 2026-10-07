// Types for wallet interactions
export interface WalletAdapter {
  name: string;
  icon: string;
  connected: boolean;
  address: string | null;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  signMessage(message: string): Promise<string>;
  signTransaction(transaction: any): Promise<string>;
}

// Mock implementations for demonstration purposes
// In a real implementation, these would integrate with actual SDKs

class FreighterAdapter implements WalletAdapter {
  name = 'Freighter';
  icon = '/icons/freighter.svg';
  connected = false;
  address: string | null = null;

  async connect(): Promise<void> {
    // Simulate Freighter connection
    this.connected = true;
    this.address = 'freighter-address-123';
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.address = null;
  }

  async signMessage(message: string): Promise<string> {
    return `freighter-signature-${message}`;
  }

  async signTransaction(transaction: any): Promise<string> {
    return `freighter-tx-signature-${transaction}`;
  }
}

class MetaMaskAdapter implements WalletAdapter {
  name = 'MetaMask';
  icon = '/icons/metamask.svg';
  connected = false;
  address: string | null = null;

  async connect(): Promise<void> {
    // Simulate MetaMask connection
    this.connected = true;
    this.address = 'metamask-address-456';
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.address = null;
  }

  async signMessage(message: string): Promise<string> {
    return `metamask-signature-${message}`;
  }

  async signTransaction(transaction: any): Promise<string> {
    return `metamask-tx-signature-${transaction}`;
  }
}

class WalletConnectAdapter implements WalletAdapter {
  name = 'WalletConnect';
  icon = '/icons/walletconnect.svg';
  connected = false;
  address: string | null = null;

  async connect(): Promise<void> {
    // Simulate WalletConnect connection
    this.connected = true;
    this.address = 'walletconnect-address-789';
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.address = null;
  }

  async signMessage(message: string): Promise<string> {
    return `walletconnect-signature-${message}`;
  }

  async signTransaction(transaction: any): Promise<string> {
    return `walletconnect-tx-signature-${transaction}`;
  }
}

class LedgerAdapter implements WalletAdapter {
  name = 'Ledger';
  icon = '/icons/ledger.svg';
  connected = false;
  address: string | null = null;

  async connect(): Promise<void> {
    // Simulate Ledger connection
    this.connected = true;
    this.address = 'ledger-address-012';
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.address = null;
  }

  async signMessage(message: string): Promise<string> {
    return `ledger-signature-${message}`;
  }

  async signTransaction(transaction: any): Promise<string> {
    return `ledger-tx-signature-${transaction}`;
  }
}

// Wallet adapter factory
export function getWalletAdapter(name: string): WalletAdapter {
  switch (name) {
    case 'Freighter':
      return new FreighterAdapter();
    case 'MetaMask':
      return new MetaMaskAdapter();
    case 'WalletConnect':
      return new WalletConnectAdapter();
    case 'Ledger':
      return new LedgerAdapter();
    default:
      throw new Error(`Unsupported wallet: ${name}`);
  }
}

// Get all available wallets
export function getAvailableWallets(): WalletAdapter[] {
  return [
    new FreighterAdapter(),
    new MetaMaskAdapter(),
    new WalletConnectAdapter(),
    new LedgerAdapter(),
  ];
}

// Local storage key for wallet preference
const WALLET_PREFERENCE_KEY = 'selected_wallet';

// Save wallet preference
export function saveWalletPreference(walletName: string): void {
  localStorage.setItem(WALLET_PREFERENCE_KEY, walletName);
}

// Get saved wallet preference
export function getSavedWalletPreference(): string | null {
  return localStorage.getItem(WALLET_PREFERENCE_KEY);
}

// Clear wallet preference
export function clearWalletPreference(): void {
  localStorage.removeItem(WALLET_PREFERENCE_KEY);
}