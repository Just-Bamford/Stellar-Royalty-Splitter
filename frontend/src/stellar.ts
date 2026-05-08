/**
 * Freighter wallet integration for signing and submitting transactions.
 * Single responsibility: wallet interaction only.
 * For transaction building, use stellar SDK directly.
 * For formatting, use utils/format.ts.
 */

import { TransactionBuilder, Networks, SorobanRpc } from "@stellar/stellar-sdk";

const RPC_URL = "https://soroban-testnet.stellar.org";
const server = new SorobanRpc.Server(RPC_URL);

/**
 * Sign and submit a transaction XDR with Freighter wallet
 */
export async function signAndSubmitTransaction(
  xdrString: string,
): Promise<string> {
  // @ts-ignore
  if (!window.freighter)
    throw new Error("Freighter wallet not found. Install it at freighter.app");

  // @ts-ignore
  const signedXdr = await window.freighter.signTransaction(xdrString, {
    network: "TESTNET",
  });

  const tx = TransactionBuilder.fromXDR(signedXdr, Networks.TESTNET);
  const sendResult = await server.sendTransaction(tx);

  if (sendResult.status === "ERROR") {
    throw new Error(
      `Transaction submission failed: ${JSON.stringify(sendResult.errorResult)}`,
    );
  }

  const hash = sendResult.hash;

  // Poll for confirmation (max 30s)
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    const result = await server.getTransaction(hash);
    if (result.status === "SUCCESS") return hash;
    if (result.status === "FAILED")
      throw new Error(`Transaction failed on-chain: ${hash}`);
  }

  throw new Error(`Transaction confirmation timed out: ${hash}`);
}
