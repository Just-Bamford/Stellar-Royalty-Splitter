import { getProjectId } from './config';

export type WalletType = 'freighter' | 'walletconnect' | 'ledger' | 'trezor';

export interface WalletInfo {
  id: WalletType;
  name: string;
  description: string;
  icon: string;
  hardware: boolean;
  available: () => Promise<boolean>;
}

export interface WalletSession {
  walletId: WalletType;
  address: string;
  netword?: string;
  connectedAt: number;
}

export interface ConnectResult {
  address: string;
  network?: string;
}

export interface HardwareConfirmation {
  walletId: WalletType;
  message: string;
  confirm: () => Promise<void>;
  reject: () => void;
}

export type HardwareConfirmationHandler = (
  confirmation: HardwareConfirmation,
) => Promise<void>;

const SESSION_STORAGE_KEY = 'stellar_wallet_session_v1';

const defaultConfirmationHandler: HardwareConfirmationHandler = async (confirmation) => {
  // Default behavior: auto-confirm after a short delay so the UI can render.
  // The WalletSelector / context can override this with a real modal.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await confirmation.confirm();
};

export class WalletManager {
  private currentSession: WalletSession | null = null;
  private confirmationHandler: HardwareConfirmationHandler = defaultConfirmationHandler;
  private listeners: Set<(session: WalletSession | null) => void> = new Set();

  constructor() {
    this.currentSession = this.readSession();
  }

  setConfirmationHandler(handler: HardwareConfirmationHandler): void {
    this.confirmationHandler = handler;
  }

  subscribe(listener: (session: WalletSession | null) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    this.listeners.forEach((l) => l(this.currentSession));
  }

  getSession(): WalletSession | null {
    return this.currentSession;
  }

  getAvailableWallets(): WalletInfo[] {
    return [
      {
        id: 'freighter',
        name: 'Freighter',
        description: 'Connect using the Freighter wallet extension.',
        icon: '🚩',
        hardware: false,
        available: async () => this.isFreighterAvailable(),
      },
      {
        id: 'walletconnect',
        name: 'WalletConnect',
        description: 'Scan QR code to connect a mobile wallet.',
        icon: '📱',
        hardware: false,
        available: async () => this.isWalletConnectAvailable(),
      },
      {
        id: 'ledger',
        name: 'Ledger',
        description: 'Connect using your Ledger hardware wallet.',
        icon: '🔑',
        hardware: true,
        available: async () => this.isLedgerAvailable(),
      },
      {
        id: 'trezor',
        name: 'Trezor',
        description: 'Connect using your Trezor hardware wallet.',
        icon: '🔨',
        hardware: true,
        available: async () => this.isTrezorAvailable(),
      },
    ];
  }

  async isFreighterAvailable(): Promise<boolean> {
    if (typeof window === 'undefined') return false;
    const anyWindow = window as unknown as {
      freighter?: unknown;
      stellar?: { signTransaction?: unknown };
    };
    return Boolean(anyWindow.freighter || anyWindow.stellar);
  }

  async isWalletConnectAvailable(): Promise<boolean> {
    return true;
  }

  async isLedgerAvailable(): Promise<boolean> {
    if (typeof navigator === 'undefined') return false;
    const anyNav = navigator as unknown as { usb?: unknown };
    return Boolean(anyNav.usb);
  }

  async isTrezorAvailable(): Promise<boolean> {
    return this.isLedgerAvailable();
  }

  async connect(walletId: WalletType): Promise<ConnectResult> {
    let result: ConnectResult;
    switch (walletId) {
      case 'freighter':
        result = await this.connectFreighter();
        break;
      case 'walletconnect':
        result = await this.connectWalletConnect();
        break;
      case 'ledger':
        result = await this.connectHardware('ledger');
        break;
      case 'trezor':
        result = await this.connectHardware('trezor');
        break;
      default:
        throw new Error(`Unsupported wallet: ${String(walletId)}`);
    }

    const session: WalletSession = {
      walletId,
      address: result.address,
      network: result.network,
      connectedAt: Date.now(),
    };
    this.setSession(session);
    return result;
  }

  async disconnect(): Promise<void> {
    const session = this.currentSession;
    if (session?.walletId === 'walletconnect') {
      try {
        const module = await import('@walletconnect/standalone');
        const client = await module.getActiveSession();
        if (client) {
          await client.disconnect();
        }
      } catch {
        // ignore disconnect errors
      }
    }
    this.setSession(null);
  }

  async switchWallet(walletId: WalletType): Promise<ConnectResult> {
    await this.disconnect();
    return this.connect(walletId);
  }

  async restoreSession(): Promise<WalletSession | null> {
    const stored = this.readSession();
    if (!stored) return null;
    try {
      await this.connect(stored.walletId);
      return this.currentSession;
    } catch {
      this.setSession(null);
      return null;
    }
  }

  private async connectFreighter(): Promise<ConnectResult> {
    if (!(await this.isFreighterAvailable())) {
      throw new Error('Freighter is not installed.');
    }
    const module = await import('@freighter/api');
    const api = module.default ?? module;
    const access = await api.requestAccess();
    if (!access || access.error) {
      throw new Error(access?.error || 'User rejected Freighter access.');
    }
    const address = access.publicKey || access.address;
    if (!address) throw new Error('Freighter did not return an address.');
    const networkResp = await api.getNetwork().catch(() => null);
    return { address, network: networkResp?.network };
  }

  private async connectWalletConnect(): Promise<ConnectResult> {
    const module = await import('@walletconnect/standalone');
    const projectId = getProjectId();
    if (!projectId) {
      throw new Error('WalletConnect project ID is not configured.');
    }
    const { StandalondSignClient } = module;
    const client = await StandaloneSignClient.init({
      projectId,
      metadata: {
        name: 'Stellar Wallet',
        description: 'Connect to Stellar dApp',
        url: typeof window !== 'undefined' ? window.location.origin : 'https://stellar',
        icons: [],
      },
      chainId: 'stellar',
    });
    const session = await client.connect();
    const address = session.namespaces?.stellar?.accounts?.[0];
    if (!address) throw new Error('WalletConnect did not return an account.');
    return { address: address.split(':').pop() as string, network: 'stellar' };
  }

  private async connectHardware(walletId: 'ledger' | 'trezor'): Promise<ConnectResult> {
    const available =
      walletId === 'ledger'
        ? await this.isLedgerAvailable()
        : await this.isTrezorAvailable();
    if (!available) {
      throw new Error(`${walletId} is not connected. Please plug in the device.`);
    }

    const confirmation: HardwareConfirmation = {
      walletId,
      message: `Confirm connection on your ${walletId === 'ledger' ? 'Ledger' : 'Trezor'} device.`,
      confirm: async () => {
        // The device itself confirms the action; this resolves once the UI has acknowledged.
      },
      reject: () => {
        throw new Error(`${walletId} connection rejected by user.`);
      },
    };
    await this.confirmationHandler(confirmation);

    const address = await this.requestHardwareAddress(walletId);
    return { address: address, network: 'stellar' };
  }

  private async requestHardwareAddress(walletId: 'ledger' | 'trezor'): Promise<string> {
    // The address is retrieved from the device via the browser USB bridge.
    // We delegate to the wallet-specific SDK if available on the window.
    const anyWindow = window as unknown as {
      stellarLedger?: { getPublicKey: () => Promise<string> };
      stellarTrezor?: { getPublicKey: () => Promise<string> };
    };
    if (walletId === 'ledger' && anyWindow.stellarLedger) {
      return anyWindow.stellarLedger.getPublicKey();
    }
    if (walletId === 'trezor' && anyWindow.stellarTrezor) {
      return anyWindow.stellarTrezor.getPublicKey();
    }
    throw new Error(
      `${walletId} bridge is not available. Ensure the device bridge is installed.`,
    );
  }

  private setSession(session: WalletSession | null): void {
    this.currentSession = session;
    if (typeof window !== 'undefined') {
      if (session) {
        window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
      } else {
        window.localStorage.removeItem(SESSION_STORAGE_KEY);
      }
    }
    this.notify();
  }

  private readSession(): WalletSession | null {
    if (typeof window === 'undefined') return null;
    try {
      const raw = window.localStorage.getItem(SESSION_STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as WalletSession;
      if (!parsed.walletId || !parsed.address) return null;
      return parsed;
    } catch {
      return null;
    }
  }
}

export const walletManager = new WalletManager();

export default walletManager;
