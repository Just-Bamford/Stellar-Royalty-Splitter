/**
 * WalletConnect adapter for multi-wallet support — closes #942.
 *
 * Implements the WalletAdapter interface for WalletConnect v1 protocol,
 * enabling mobile wallets and hardware wallet users to connect via QR code
 * and sign transactions remotely.
 *
 * WalletConnect Session Flow:
 * 1. Create provider with projectId
 * 2. Display QR code (provider.uri)
 * 3. Mobile app scans QR and establishes session
 * 4. Provider emits 'connect' event with connected address
 * 5. signTransaction sends XDR to mobile, waits for signature
 * 6. Mobile confirms and returns signed XDR
 */

import WalletConnectProvider from "@walletconnect/web3-provider";
import { TransactionBuilder, Networks } from "@stellar/stellar-sdk";

export interface WalletConnectConfig {
  projectId: string;
  network?: "testnet" | "mainnet";
  onSessionConnect?: (address: string) => void;
  onSessionDisconnect?: () => void;
  onQRCodeURI?: (uri: string) => void;
}

interface SessionInfo {
  address: string;
  chainId: string;
  sessionId: string;
}

/**
 * WalletConnect adapter implementing the WalletAdapter interface.
 * Handles session establishment, QR code display, and transaction signing.
 */
export class WalletConnectAdapter {
  private provider: WalletConnectProvider | null = null;
  private config: WalletConnectConfig;
  private session: SessionInfo | null = null;
  private qrCodeURI: string | null = null;

  constructor(config: WalletConnectConfig) {
    if (!config.projectId) {
      throw new Error("WalletConnect projectId is required");
    }
    this.config = {
      network: "testnet",
      ...config,
    };
  }

  /**
   * Initialize the WalletConnect provider (called once, before connect).
   * Does NOT establish a session — use connect() for that.
   */
  private async initializeProvider(): Promise<void> {
    if (this.provider) return; // Already initialized

    const rpcUrl =
      this.config.network === "mainnet"
        ? "https://soroban-mainnet.stellar.org"
        : "https://soroban-testnet.stellar.org";

    const rpcMap = {
      148: rpcUrl, // Stellar testnet chainId is 148, mainnet is 280
    };

    this.provider = new WalletConnectProvider({
      projectId: this.config.projectId,
      chains: [this.config.network === "mainnet" ? 280 : 148],
      methods: ["stellar_signTransaction"],
      events: ["chainChanged", "accountsChanged"],
      rpcMap,
      metadata: {
        name: "Stellar Royalty Splitter",
        description: "Transparent royalty distribution on Stellar",
        url: window.location.origin,
        icons: [`${window.location.origin}/favicon.svg`],
      },
      showQrModal: false, // We display QR ourselves
    });

    // Set up event listeners
    this.provider.on("display_uri", (uri: string) => {
      this.qrCodeURI = uri;
      this.config.onQRCodeURI?.(uri);
    });

    this.provider.on("session_connected", (session: any) => {
      const address = session?.accounts?.[0];
      if (address) {
        this.session = {
          address,
          chainId: session.chainId?.toString() || "148",
          sessionId: session.topic || "",
        };
        this.config.onSessionConnect?.(address);
      }
    });

    this.provider.on("session_deleted", () => {
      this.session = null;
      this.qrCodeURI = null;
      this.config.onSessionDisconnect?.();
    });

    this.provider.on("session_expired", () => {
      this.session = null;
      this.qrCodeURI = null;
      this.config.onSessionDisconnect?.();
    });
  }

  /**
   * Connect to WalletConnect and await mobile wallet approval.
   * Displays QR code via onQRCodeURI callback.
   *
   * @throws Error if connection fails, times out, or is rejected
   * @returns Promise that resolves when session is established
   */
  async connect(): Promise<void> {
    try {
      await this.initializeProvider();

      if (!this.provider) {
        throw new Error("Failed to initialize WalletConnect provider");
      }

      // Enable session with 60 second timeout
      const enablePromise = this.provider.enable();
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("WalletConnect session timeout")),
          60000,
        ),
      );

      await Promise.race([enablePromise, timeoutPromise]);

      // Extract first account from enabled provider
      const accounts = await this.provider.request({
        method: "stellar_accounts",
        params: {},
      });

      if (!accounts || accounts.length === 0) {
        throw new Error("No accounts returned from WalletConnect session");
      }

      this.session = {
        address: accounts[0],
        chainId: this.config.network === "mainnet" ? "280" : "148",
        sessionId: this.provider.session?.topic || "",
      };

      this.config.onSessionConnect?.(this.session.address);
    } catch (err: any) {
      this.session = null;
      this.qrCodeURI = null;
      throw new Error(
        `WalletConnect connection failed: ${err.message || String(err)}`,
      );
    }
  }

  /**
   * Disconnect the WalletConnect session.
   */
  async disconnect(): Promise<void> {
    if (!this.provider || !this.session) return;

    try {
      await this.provider.disconnect();
    } catch (err) {
      console.warn("Error disconnecting WalletConnect:", err);
    } finally {
      this.session = null;
      this.qrCodeURI = null;
      this.config.onSessionDisconnect?.();
    }
  }

  /**
   * Get the current Stellar address (or null if not connected).
   */
  getAddress(): string | null {
    return this.session?.address || null;
  }

  /**
   * Get the current QR code URI (for display after connect() is called).
   */
  getQRCodeURI(): string | null {
    return this.qrCodeURI;
  }

  /**
   * Check if currently connected.
   */
  isConnected(): boolean {
    return Boolean(this.session && this.provider);
  }

  /**
   * Sign a Stellar transaction XDR string.
   *
   * Sends the XDR to the connected mobile wallet, waits for user confirmation,
   * and returns the signed XDR. Uses 90 second timeout.
   *
   * @param xdr Unsigned transaction XDR
   * @param network "testnet" or "mainnet" (must match session)
   * @throws Error if not connected, signing fails, or times out
   * @returns Signed transaction XDR
   */
  async signTransaction(xdr: string, network: "testnet" | "mainnet" = "testnet"): Promise<string> {
    if (!this.session || !this.provider) {
      throw new Error("WalletConnect: not connected");
    }

    // Validate that network matches session
    const expectedChainId = network === "mainnet" ? "280" : "148";
    if (this.session.chainId !== expectedChainId) {
      throw new Error(
        `Network mismatch: session is on chain ${this.session.chainId}, expected ${expectedChainId}`,
      );
    }

    try {
      const signPromise = this.provider.request({
        method: "stellar_signTransaction",
        params: {
          xdr,
          network: network.toUpperCase(),
        },
      });

      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("WalletConnect signing timeout")),
          90000,
        ),
      );

      const result = await Promise.race([signPromise, timeoutPromise]);

      if (!result || typeof result !== "string") {
        throw new Error("Invalid signature response from WalletConnect");
      }

      return result;
    } catch (err: any) {
      throw new Error(
        `WalletConnect signing failed: ${err.message || String(err)}`,
      );
    }
  }

  /**
   * Sign a message (not typically used for Stellar, but included for completeness).
   */
  async signMessage(message: string): Promise<string> {
    if (!this.provider) {
      throw new Error("WalletConnect: not connected");
    }

    try {
      // Use a simple signed message pattern
      const result = await this.provider.request({
        method: "stellar_signMessage",
        params: {
          message,
        },
      });

      if (!result || typeof result !== "string") {
        throw new Error("Invalid message signature response");
      }

      return result;
    } catch (err: any) {
      throw new Error(
        `WalletConnect message signing failed: ${err.message || String(err)}`,
      );
    }
  }
}

/**
 * Factory to create a WalletConnect adapter instance.
 * Requires VITE_WALLETCONNECT_PROJECT_ID env var.
 */
export function createWalletConnectAdapter(
  network: "testnet" | "mainnet" = "testnet",
  callbacks?: {
    onSessionConnect?: (address: string) => void;
    onSessionDisconnect?: () => void;
    onQRCodeURI?: (uri: string) => void;
  },
): WalletConnectAdapter {
  const projectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID;
  if (!projectId) {
    throw new Error(
      "VITE_WALLETCONNECT_PROJECT_ID environment variable is required",
    );
  }

  return new WalletConnectAdapter({
    projectId,
    network,
    ...callbacks,
  });
}

export type { WalletConnectConfig };
