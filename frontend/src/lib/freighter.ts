/**
 * Shared Freighter wallet type augmentation and network detection helper.
 * Single source of truth for the `window.freighter` shape so every module
 * that talks to the extension (WalletConnect, NetworkContext, stellar.ts)
 * agrees on it.
 */

// Freighter injects window.freighter at runtime — no official type package
// available, so we use type assertions with explicit comments rather than
// @ts-ignore.
declare global {
  interface Window {
    freighter?: {
      requestAccess?: () => Promise<{ address: string }>;
      getAddress?: () => Promise<{ address: string }>;
      getPublicKey?: () => Promise<string>;
      signTransaction?: (
        xdr: string,
        options?: { network?: string },
      ) => Promise<string>;
      getNetwork?: () => Promise<{ network: string; networkPassphrase?: string }>;
      getNetworkDetails?: () => Promise<{ network: string; networkPassphrase?: string }>;
      on?: (event: string, handler: (data: { address: string }) => void) => void;
    };
  }
}

/**
 * Returns the raw network name reported by the connected Freighter wallet
 * (e.g. "TESTNET", "PUBLIC", "FUTURENET"), or `null` if Freighter is not
 * installed or the network could not be determined.
 */
export async function getFreighterNetwork(): Promise<string | null> {
  if (!window.freighter) return null;

  try {
    if (window.freighter.getNetwork) {
      const { network } = await window.freighter.getNetwork();
      return network ? network.toUpperCase() : null;
    }
    if (window.freighter.getNetworkDetails) {
      const { network } = await window.freighter.getNetworkDetails();
      return network ? network.toUpperCase() : null;
    }
  } catch {
    // Wallet locked, request rejected, or not yet authorized — treat as
    // "unknown" rather than surfacing an error.
  }

  return null;
}

export {};
