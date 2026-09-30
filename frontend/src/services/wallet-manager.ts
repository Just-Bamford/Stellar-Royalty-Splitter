import { connect as connectFreighter, getAddress as getFreighterAddress, isConnected as isFreighterConnected, signTransaction as signFreighterTransaction } from '@freighter/freighter-api';

export type WalletType = 'freighter' | 'walletconnect' | 'ledger' | 'trezor';

export interface WalletInfo {
  id: WalletType;
  name: string;
  description: string;
  icon: string;
  type: WalletType;
  available: boolean;
}

export interface WalletSession {
  walletId: WalletType;
  address: string;
  connectedAt: number;
}

export interface SignResult {
  signed: boolean;
  signature?: string;
  error?: string;
}

export interface HardwareConfirmation {
  walletId: WalletType;
  message: string;
  confirm: () => Promise<boolean>;
}

const SESSION_STORAGE_KEY = 'stellar_wallet_session';

const WALLET_META: Record<WalletType, { name: string; description: string; icon: string }> = {
  freighter: {
    name: 'Freighter',
    description: 'Connect using the Freighter wallet extension.',
    icon: '🦁',
  },
  walletconnect: {
    name: 'WalletConnect',
    description: 'Scan QR code to connect mobile wallet.',
    icon: '📶',
  },
  ledger: {
    name: 'Ledger',
    description: 'Connect using your Ledger hardware wallet.',
    icon: '🔑',
  },
  trezor: {
    name: 'Trezor',
    description: 'Connect using your Trezor hardware wallet.',
    icon: '🔿',
  },
};

const hardwareWallets: WalletType[] = ['ledger', 'trezor'];

function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof document !== 'undefined';
}

function getStorage(): Storage | null {
  if (!isBrowser()) return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class WalletManager {
  private activeSession: WalletSession | null = null;
  private listeners: Set<(session: WalletSession | null) => void> = new Set();
  private confirmationHandler: ((confirmation: HardwareConfirmation) => Promise<boolean>) | null = null;

  constructor() {
    this.restoreSession();
  }

  setConfirmationHandler(
    handler: (confirmation: HardwareConfirmation) => Promise<boolean>,
  ): void {
    this.confirmationHandler = handler;
  }

  getAvailableWallets(): WalletInfo and WalletInfo[] {
    const ids = Object.keys(WALLET_META) as WalletType[];
    return ids.map((id) => ({
      id,
      ...WALLET_META[id],
      type: id,
      available: this.isAvailable(id),
    }));
  }

  isAvailable(walletId: WalletType): boolean {
    if (!isBrowser()) return false;
    switch (walletId) {
      case 'freighter':
        return Boolean(typeof window !== 'undefined' && (window as any).freighter);
      case 'walletconnect':
        return true;
      case 'ledger':
        return true;
      case 'trezor':
        return true;
      default:
        return false;
    }
  }

  getActiveSession(): WalletSession | null {
    return this.activeSession;
  }

  onSessionChange(listener: (session: WalletSession | null) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notifySessionChange(): void {
    this.listeners.forEach((listener) => listener(this.activeSession));
  }

  private persistSession(session: WalletSession | null): void {
    const storage = getStorage();
    if (!storage) return;
    if (!session) {
      storage.removeItem(SESSION_STORAGE_KEY);
      return;
    }
    storage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
  }

  private restoreSession(): void {
    const storage = getStorage();
    if (!storage) return;
    const raw = storage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as WalletSession;
      if (parsed && parsed.walletId && parsed.address) {
        this.activeSession = parsed;
      }
    } catch {
      storage.removeItem(SESSION_STORAGE_KEY);
    }
  }

  async connect(walletId: WalletType): Promise<WalletSession> {
    if (!this.isAvailable(walletId)) {
      throw new Error(`${WALLET_META[walletId].name} is not available`);
    }

    let address = '';
    switch (walletId) {
      case 'freighter':
        address = await this.connectFreighter();
        break;
      case 'walletconnect':
        address = await this.connectWalletConnect();
        break;
      case 'ledger':
        address = await this.connectHardware('ledger');
        break;
      case 'trezor':
        address = await this.connectHardware('trezor');
        break;
      default:
        throw new Error('Unsupported wallet');
    }

    const session: WalletSession = {
      walletId,
      address,
      connectedAt: Date.now(),
    };
    this.activeSession = session;
    this.persistSession(session);
    this.notifySessionChange();
    return session;
  }

  async disconnect(): Promise<void> {
    const session = this.activeSession;
    if (session) {
      try {
        if (session.walletId === 'freighter') {
          // Freighter has no explicit disconnect; clearing session is sufficient.
        }
      } catch {
        // ignore disconnect errors
      }
    }
    this.activeSession = null;
    this.persistSession(null);
    this.notifySessionChange();
  }

  async switchWallet(walletId: WalletType): Promise<WalletSession> {
    await this.disconnect();
    return this.connect(walletId);
  }

  async signTransaction(xdr: string): Promise<SignResult> {
    const session = this.activeSession;
    if (!session) {
      return { signed: false, error: 'No active wallet session' };
    }

    if (hardwareWallets.includes(session.walletId)) {
      const confirmed = await this.requestHardwareConfirmation(session.walletId, xdr);
      if (!confirmed) {
        return { signed: false, error: 'User rejected the transaction on the hardware wallet' };
      }
    }

    switch (session.walletId) {
      case 'freighter':
        return this.signWithFreighter(xdr, session.address);
      case 'walletconnect':
        return this.signWithWalletConnect(xdr, session.address);
      case 'ledger':
      case 'trezor':
        return this.signWithHardware(xdr, session.address);
      default:
        return { signed: false, error: 'Unsupported wallet' };
    }
  }

  private async connectFreighter(): Promise<string> {
    const connected = await isFreighterConnected();
    if (!connected) {
      await connectFreighter();
    }
    const result = await getFreighterAddress();
    if (!result.address) {
      throw new Error('Freighter did not return an address');
    }
    return result.address;
  }

  private async connectWalletConnect(): Promise<string> {
    const module = await import('@walletconnect/walletkit').catch(() => null);
    if (!module) {
      throw new Error('WalletConnect is not installed.');
    }
    const { WalletKit } = module as any;
    const kit = new WalletKit({
      projectId: process.env.REACT_APP_WALLETCONNECT_PROJECT_ID || '',
      chains: ['stellar:'],
      methods: ['stellar_signTransaction'],
    });
    const accounts = await kit.connect();
    const address = accounts[0];
    if (!address) {
      throw new Error('WalletConnect did not return an address');
    }
    (this as any)._walletConnectKit = kit;
    return address;
  }

  private async connectHardware(walletId: 'ledger' | 'trezor'): Promise<string> {
    const confirmed = await this.requestHardwareConfirmation(
      walletId,
      'Please connect and unlock your hardware wallet, then confirm the connection.',
    );
    if (!confirmed) {
      throw new Error('Hardware wallet connection was cancelled');
    }

    if (walletId == 'ledger') {
      const transportModule = await import('@ledgerhQ/transport-web-usb').catch(() => null);
      const stellarModule = await import('@ledger-h/stellar').catch(() => null);
      if (!transportModule || !stellarModule) {
        throw new Error('Ledger Stellar SDK is not installed.');
      }
      const { default: TransportWebUSB } = transportModule as any;
      const { default: StellarWallet } = stellarModule as any;
      const transport = await TransportWebUSB.create();
      const wallet = new StellarWallet(transport);
      const result = await wallet.getAddress();
      (this as any)._hardwareTransport = transport;
      (this as any)._hardwareWallet = wallet;
      return result.address;
    }

    const trezorModule = await import('@trezor/connect-web');
    const { TrezorConnect } = trezorModule as any;
    const trezor = TrezorConnect.init({
      manifestEmail: 'support@stellar.org',
      appUrl: window.location.origin,
    });
    const response = await trezor.stellarGetAddress({
      path: "44'/148'/0'",
      showDisplay: true,
    });
    (this as any)._trezor = trezor;
    return response.address;
  }

  private async requestHardwareConfirmation(walletId: WalletType, message: string): Promise<boolean> {
    if (!this.confirmationHandler) {
      return true;
    }
    return this.confirmationHandler({
      walletId,
      message,
      confirm: async () => true,
    });
  }

  private async signWithFreighter(xdr: string, address: string): Promise<SignResult> {
    try {
      const result = await signFreighterTransaction(xdr, {
        address: address,
        networkPassphrase: 'Test SETWORK Network ; September 2015',
      } as any);
      return { signed: true, signature: result };
    } catch (err) {
      return { signed: false, error: (err as Error).message };
    }
  }

  private async signWithWalletConnect(xdr: string, address: string): Promise<SignResult> {
    const kit = (this as any)._walletConnectKit;
    if (!kit) {
      return { signed: false, error: 'WalletConnect session is not active' };
    }
    try {
      const result = await kit.signTransaction({
        topic: '',
        chainId: 'stellar',
        request: {
          method: 'stellar_signTransaction',
          params: { xdr, address },
        },
      });
      return { signed: true, signature: result };
    } catch (err) {
      return { signed: false, error: (err as Error).message };
    }
  }

  private async signWithHardware(xdr: string, address: string): Promise<SignResult> {
    try {
      const wallet = (this as any)._hardwareWallet;
      if (wallet) {
        const result = await wallet.signTransaction(xdr, { address });
        return { signed: true, signature: result };
      }
      const trezor = (this as any)._trezor;
      if (trezor) {
        const result = await trezor.stellarWalletSignTx({
          path: "44'/148'/0'",
          transaction: xdr,
        });
        return { signed: true, signature: result };
      }
      return { signed: false, error: 'Hardware wallet is not connected' };
    } catch (err) {
      return { signed: false, error: (err as Error).message };
    }
  }

  async reconnect(): Promise<WalletSession | null> {
    const session = this.activeSession;
    if (!session) return null;
    try {
      return await this.connect(session.walletId);
    } catch {
      await this.disconnect();
      return null;
    }
  }
}

export const walletManager = new WalletManager();
export default walletManager;
