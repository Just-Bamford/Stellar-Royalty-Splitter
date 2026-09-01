/**
 * Validation benchmarks (#867).
 *
 * Why these paths: every write request passes through `validate()` before it
 * reaches any business logic, so a regression here is paid by every caller on
 * every request. They are also the cheapest thing in the stack, which makes
 * them the most likely to be quietly made expensive — a `.refine()` that does
 * a little too much work is invisible in a functional test and obvious here.
 *
 * All inputs are fixed. `initializeSchema` in particular is superlinear in
 * collaborator count (it validates each address and then sums the shares), so
 * both the 1-collaborator and the 10-collaborator cases are measured.
 */

import {
  initializeSchema,
  distributeSchema,
  batchDistributeSchema,
  recordSecondarySaleSchema,
  parseCursorPagination,
  encodeCursor,
} from "../../src/validation.js";

// Fixed, valid Stellar account addresses. Real checksums, so the address
// refinement runs its full StrKey path rather than short-circuiting on the
// regex — otherwise the benchmark would measure the cheap rejection instead
// of the expensive accept.
const ACCOUNTS = [
  "GBDIA62PY5P5MSTMR3DSVAQ4TITI3JJWWMW2NAI2QZKMPTTKSLG5JU6L",
  "GAV4DGP22KP4ZWOFJXMVWNRCFFYU6BFDQHEYJAHONQHFRH4GSY4GFQRN",
  "GCS3HJDDTO6RAKEBYBA7KB3TLTVR4J3GPIT7FIWNEA6BFIDUA3Q4ADKI",
  "GBZSNVYQOMVZKGCJTYEM2YSK5RW3LFHLJ4MNKZNYMX44TGRHESDLDBXV",
  "GDVWFXWIMSTF2ZUJVQYWWDSGUFO5R5CRUZLIK3GEKFFZXAEDSOZEDKTT",
  "GBF5GIGZT3SORXVJBJQOTEVM5FFJAXGZY2UYFMNNYTDABTVEBOBQ57AR",
  "GDPQAM2KNJLZYBXIJQ564JZY7NO4E6XE7LSV2ZHEFEFIQI3WVY2J2NYJ",
  "GA4IFOZZU4GJ3WZWPVCHADZXNULJU3ZZGSV3ZJTTTPQTZLNJSULRV6X4",
  "GBYUONUD5HU4F6XCMDTNFJHJ6V4NIXW6DYIOYQTCGZN22WJKGH5XCFGS",
  "GCUMXL3YR42MWGERO7M5NLR77DBBQA3MJIKEBGL55LFWUGBJA6TMJF3V",
];

const CONTRACT = "CFIDWUVTWDSZTKLPVFRQQ42WFLK3I572742JAQV7ZHCM4UKZTZRJWH6P";
const TOKEN = "CIGTZ2LCHGNCEFHAVKMZP52FGJKAPRWJJRWNUCZPIIENJ4RLGYNKCLF2";

/** Split 10 000 basis points exactly across n collaborators. */
function exactShares(n) {
  const base = Math.floor(10000 / n);
  const shares = Array.from({ length: n }, () => base);
  shares[n - 1] += 10000 - base * n;
  return shares;
}

function initializeBody(n) {
  return {
    contractId: CONTRACT,
    walletAddress: ACCOUNTS[0],
    collaborators: ACCOUNTS.slice(0, n),
    shares: exactShares(n),
  };
}

const INITIALIZE_1 = initializeBody(1);
const INITIALIZE_10 = initializeBody(10);

const DISTRIBUTE = {
  contractId: CONTRACT,
  walletAddress: ACCOUNTS[0],
  tokenId: TOKEN,
  amount: 1_000_000,
};

const BATCH_50 = {
  walletAddress: ACCOUNTS[0],
  operations: Array.from({ length: 50 }, () => ({
    contractId: CONTRACT,
    tokenId: TOKEN,
    amount: 1000,
  })),
};

const SECONDARY_SALE = {
  contractId: CONTRACT,
  walletAddress: ACCOUNTS[0],
  nftId: "nft-000042",
  previousOwner: ACCOUNTS[1],
  newOwner: ACCOUNTS[2],
  salePrice: 5_000_000,
  saleToken: TOKEN,
  royaltyRate: 500,
};

// A rejected body exercises the error-collection path, which is materially
// more expensive than the accept path and is what a hostile client hits.
const INITIALIZE_INVALID = {
  ...INITIALIZE_10,
  shares: exactShares(10).map((s) => s + 1),
};

const CURSOR = encodeCursor("2026-01-01T00:00:00.000Z", 4242);

/** @type {import("../runner.js").Scenario[]} */
export default [
  {
    name: "validation/initialize/1-collaborator",
    group: "validation",
    description: "initializeSchema.safeParse on a minimal valid body",
    iterations: 200,
    batch: 20,
    warmup: 50,
    run: () => initializeSchema.safeParse(INITIALIZE_1),
  },
  {
    name: "validation/initialize/10-collaborators",
    group: "validation",
    description: "initializeSchema.safeParse at the MAX_COLLABORATORS limit",
    iterations: 200,
    batch: 5,
    warmup: 50,
    run: () => initializeSchema.safeParse(INITIALIZE_10),
  },
  {
    name: "validation/initialize/rejected",
    group: "validation",
    description: "initializeSchema.safeParse on a body failing the share-sum refinement",
    iterations: 200,
    batch: 5,
    warmup: 50,
    run: () => initializeSchema.safeParse(INITIALIZE_INVALID),
  },
  {
    name: "validation/distribute",
    group: "validation",
    description: "distributeSchema.safeParse on a valid body",
    iterations: 200,
    batch: 50,
    warmup: 50,
    run: () => distributeSchema.safeParse(DISTRIBUTE),
  },
  {
    name: "validation/batch-distribute/50-operations",
    group: "validation",
    description: "batchDistributeSchema.safeParse at the MAX_BATCH_OPERATIONS limit",
    iterations: 200,
    batch: 10,
    warmup: 50,
    run: () => batchDistributeSchema.safeParse(BATCH_50),
  },
  {
    name: "validation/secondary-sale",
    group: "validation",
    description: "recordSecondarySaleSchema.safeParse on a valid body",
    iterations: 200,
    batch: 20,
    warmup: 50,
    run: () => recordSecondarySaleSchema.safeParse(SECONDARY_SALE),
  },
  {
    name: "validation/cursor-decode",
    group: "validation",
    description: "parseCursorPagination on a base64 cursor — runs on every paged read",
    iterations: 200,
    batch: 500,
    warmup: 50,
    run: () =>
      parseCursorPagination({ limit: "50", cursor: CURSOR }, { status: () => ({ json: () => {} }) }),
  },
];
