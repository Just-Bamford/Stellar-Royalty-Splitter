export const VALID_CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
export const VALID_TOKEN_ID = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
export const VALID_WALLET_A = "GAPTAQKSMN2ILFVHXDE5V274BUPC6QCRMJZYJFNGW7ENT2X3BQOS4M3C";
export const VALID_WALLET_B = "GA7E6YDRQKJ2JNOG27UPSCQ3FQ6U4X3QQGJKHNGF23T7QCI2FM6E3W2P";
export const VALID_WALLET_C = "GBOW474QUGZMHVHF6YDRQKJ2JNOG27UPUCY4FU7E6UDBOKBZJJNWYPSI";

/** Build a default initialize request body. */
export function buildInitializePayload(overrides = {}) {
  return {
    contractId: VALID_CONTRACT_ID,
    walletAddress: VALID_WALLET_A,
    collaborators: [VALID_WALLET_B, VALID_WALLET_C],
    shares: [5000, 5000],
    ...overrides,
  };
}

/** Build an initialize request body with `count` valid collaborators. */
export function buildInitializePayloadWithCollaborators(count) {
  const wallets = [VALID_WALLET_A, VALID_WALLET_B, VALID_WALLET_C];
  const collaborators = Array.from({ length: count }, (_, i) => wallets[i % wallets.length]);
  const baseShare = Math.floor(10000 / count);
  const shares = Array.from({ length: count }, (_, i) =>
    i === count - 1 ? 10000 - baseShare * (count - 1) : baseShare,
  );
  return buildInitializePayload({ collaborators, shares });
}

/** Build a default distribute request body. */
export function buildDistributePayload(overrides = {}) {
  return {
    contractId: VALID_CONTRACT_ID,
    walletAddress: VALID_WALLET_A,
    tokenId: VALID_TOKEN_ID,
    ...overrides,
  };
}

/** Build a secondary-sale request body. */
export function buildSecondarySalePayload(overrides = {}) {
  return {
    contractId: VALID_CONTRACT_ID,
    walletAddress: VALID_WALLET_A,
    nftId: "nft-1",
    previousOwner: VALID_WALLET_B,
    newOwner: VALID_WALLET_C,
    salePrice: 1000,
    saleToken: VALID_TOKEN_ID,
    royaltyRate: 500,
    ...overrides,
  };
}

/** Run async steps sequentially and return each result in order. */
export async function runBatch(steps) {
  const results = [];
  for (const step of steps) {
    results.push(await step());
  }
  return results;
}
