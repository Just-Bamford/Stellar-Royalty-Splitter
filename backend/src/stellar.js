/**
 * Shared Soroban RPC client and helpers.
 * Real transactions are assembled here and returned as XDR so the
 * frontend can sign them with Freighter before submission.
 */
import {
  Contract,
  Networks,
  SorobanRpc,
  TransactionBuilder,
  BASE_FEE,
  nativeToScVal,
  Address,
  Account,
  xdr,
} from "@stellar/stellar-sdk";

const RPC_URL =
  process.env.SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org";
const NETWORK = process.env.STELLAR_NETWORK ?? "testnet";

export const server = new SorobanRpc.Server(RPC_URL, { allowHttp: false });
export const networkPassphrase =
  NETWORK === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;

/**
 * Build an unsigned Soroban transaction XDR for a contract invocation.
 * The frontend signs and submits it.
 */
export async function buildTx(callerAddress, contractId, method, args = []) {
  const account = await server.getAccount(callerAddress);
  const contract = new Contract(contractId);

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();

  const prepared = await server.prepareTransaction(tx);
  return prepared.toXDR();
}

/**
 * Retry wrapper for buildTx with friendly error handling.
 */
export async function retryBuildTx(callerAddress, contractId, method, args = []) {
  const maxRetries = 3;
  const backoffMs = 1000;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await buildTx(callerAddress, contractId, method, args);
    } catch (error) {
      const isLastAttempt = attempt === maxRetries;
      const isNetworkError = error.message?.includes('network') || error.message?.includes('timeout') || error.code === 'ENOTFOUND';
      const isAccountNotFound = error.message?.includes('account not found');
      const isSimulationError = error.message?.includes('simulation') || error.message?.includes('prepare');

      if (isAccountNotFound) {
        throw { status: 400, message: "Caller account not found on Stellar network" };
      }
      if (isNetworkError || isSimulationError) {
        if (isLastAttempt) {
          throw { status: 503, message: "Stellar RPC is currently unavailable. Please try again later." };
        }
        await new Promise(resolve => setTimeout(resolve, backoffMs));
        continue;
      }
      // Re-throw other errors as-is
      throw error;
    }
  }
}

// ── ScVal helpers ────────────────────────────────────────────────────────

export function addressToScVal(addr) {
  return new Address(addr).toScVal();
}

export function u32ToScVal(n) {
  return xdr.ScVal.scvU32(n);
}

export function i128ToScVal(n) {
  return nativeToScVal(BigInt(n), { type: "i128" });
}

export function vecToScVal(items) {
  return xdr.ScVal.scvVec(items);
}

/**
 * Fetch the royalty rate from the contract using a read-only simulation.
 * Returns the rate as a u32 (basis points), or 0 on error.
 */
export async function getRoyaltyRateFromContract(contractId) {
  const contract = new Contract(contractId);
  const dummyAccount = new Account(
    "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
    "0",
  );
  const tx = new TransactionBuilder(dummyAccount, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(contract.call("get_royalty_rate"))
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (SorobanRpc.Api.isSimulationError(sim)) return 0;
  return sim.result?.retval?.u32() ?? 0;
}

/**
 * Check if a contract has been initialized by simulating is_initialized().
 * Returns true if initialized, false if not.
 */
export async function isContractInitialized(contractId) {
  const contract = new Contract(contractId);
  const dummyAccount = new Account(
    "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
    "0",
  );
  const tx = new TransactionBuilder(dummyAccount, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(contract.call("is_initialized"))
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (SorobanRpc.Api.isSimulationError(sim)) return false;
  return sim.result?.retval?.bool() ?? false;
}
