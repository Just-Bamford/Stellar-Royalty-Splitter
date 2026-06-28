import type { Network } from "../context/NetworkContext";

/**
 * Build a Stellar Expert explorer URL for a transaction hash (#299).
 */
export function getStellarExpertTxUrl(network: Network, txHash: string): string {
  const segment = network === "mainnet" ? "public" : "testnet";
  return `https://stellar.expert/explorer/${segment}/tx/${txHash}`;
}

/**
 * Truncate a transaction hash for display while keeping it identifiable.
 */
export function formatTxHash(hash: string, head = 8, tail = 8): string {
  if (hash.length <= head + tail + 3) return hash;
  return `${hash.slice(0, head)}…${hash.slice(-tail)}`;
}
