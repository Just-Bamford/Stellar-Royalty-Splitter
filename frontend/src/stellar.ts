/**
 * Freighter wallet integration for signing and submitting transactions.
 * Single responsibility: wallet interaction only.
 * For transaction building, use stellar SDK directly.
 * For formatting, use utils/format.ts.
 */

import { TransactionBuilder, Networks, SorobanRpc } from "@stellar/stellar-sdk";
import { FREIGHTER_NETWORK_NAMES, type Network } from "./context/NetworkContext";
import {
  isTransientSubmissionError,
  submitTransactionWithRetry,
  type SubmissionRetryInfo,
} from "./lib/submission-retry";

const RPC_URLS: Record<Network, string> = {
  testnet: "https://soroban-testnet.stellar.org",
  mainnet: "https://soroban-mainnet.stellar.org",
};

const NETWORK_PASSPHRASES: Record<Network, string> = {
  testnet: Networks.TESTNET,
  mainnet: Networks.PUBLIC,
};

export interface SignAndSubmitOptions {
  /**
   * Invoked before each submission retry so the UI can surface a single
   * stable "retrying…" state instead of failing the user out.
   */
  onRetry?: (info: SubmissionRetryInfo) => void;
}

/**
 * Sign and submit a transaction XDR with Freighter wallet.
 *
 * The signed transaction is sent through `submitTransactionWithRetry`, which
 * transparently retries transient submission failures (RPC timeout, network
 * hiccup, rate limit, gateway errors) with exponential backoff
 * (100ms → 500ms → 2s, up to 3 retries). Permanent failures — validation,
 * auth, and deterministic RPC rejections — fail fast. Retrying the same
 * signed transaction is safe: the network deduplicates by hash, so a lost
 * response can never cause a double distribution (a duplicate resubmission
 * just reports DUPLICATE and confirmation polling proceeds).
 */
export async function signAndSubmitTransaction(
  xdrString: string,
  network: Network = "testnet",
  options: SignAndSubmitOptions = {},
): Promise<string> {
  // @ts-ignore
  if (!window.freighter)
    throw new Error("Freighter wallet not found. Install it at freighter.app");

  const passphrase = NETWORK_PASSPHRASES[network];
  const rpcUrl = RPC_URLS[network];
  const server = new SorobanRpc.Server(rpcUrl);

  // @ts-ignore
  const signedXdr = await window.freighter.signTransaction(xdrString, {
    network: FREIGHTER_NETWORK_NAMES[network],
  });

  const tx = TransactionBuilder.fromXDR(signedXdr, passphrase);
  const hash = await submitTransactionWithRetry(server, tx, {
    onRetry: options.onRetry,
  });

  // Poll for confirmation (max 30s)
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    let result;
    try {
      result = await server.getTransaction(hash);
    } catch (error) {
      // A transient RPC hiccup while polling confirmation is not a permanent
      // failure — keep polling until the deadline instead of failing the
      // whole submission.
      const analysis = isTransientSubmissionError(error);
      if (analysis.transient) {
        console.warn("[stellar] transient RPC error while polling confirmation — continuing", {
          event: "confirmation_poll_transient",
          reason: analysis.reason,
          txHash: hash,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      throw error;
    }
    if (result.status === "SUCCESS") return hash;
    if (result.status === "FAILED")
      throw new Error(`Transaction failed on-chain: ${hash}`);
  }

  throw new Error(`Transaction confirmation timed out: ${hash}`);
}
