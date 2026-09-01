/**
 * API request-body generators for the fuzz suite (#866).
 *
 * Each generator produces a body for one real endpoint schema in
 * `backend/src/validation.js`. They emit a mix of well-formed bodies (so the
 * "valid input is accepted and normalised, never corrupted" invariants have
 * something to bite on) and structurally-plausible-but-invalid bodies, which
 * is where validation bugs actually live — a body that is obvious garbage is
 * rejected by the first check and never reaches the interesting code paths.
 *
 * Every generator returns `{ body, expectValid }`. `expectValid` is the
 * generator's own claim about whether the schema should accept the body; the
 * suites assert against the schema, not against this flag, and only use it to
 * confirm that known-good bodies are not being rejected.
 */

import {
  MAX_COLLABORATORS,
  MAX_BATCH_OPERATIONS,
  MAX_NFT_ID_LENGTH,
  MAX_SALE_PRICE,
} from "../../../backend/src/validation.js";
import {
  validStellarAddress,
  validContractAddress,
  malformedStellarAddress,
  malformedContractAddress,
  basisPointsValue,
  boundaryInteger,
  hostileString,
  oversizedString,
  deeplyNested,
  unexpectedType,
} from "./primitives.js";

/**
 * Split 10 000 basis points across `n` recipients so the total is exact.
 * Mirrors the remainder-to-last-recipient rule the contract itself uses.
 */
export function exactShares(n) {
  const base = Math.floor(10000 / n);
  const shares = Array.from({ length: n }, () => base);
  shares[n - 1] += 10000 - base * n;
  return shares;
}

/** Distinct valid addresses, so collaborator lists have no accidental dupes. */
function distinctAddresses(rng, count) {
  const seen = new Set();
  const out = [];
  // The valid-address pool is finite; once exhausted, fall back to repeats,
  // which is itself a case worth generating (duplicate collaborators).
  for (let attempts = 0; out.length < count && attempts < count * 20; attempts += 1) {
    const addr = validStellarAddress(rng);
    if (seen.has(addr)) continue;
    seen.add(addr);
    out.push(addr);
  }
  while (out.length < count) out.push(validStellarAddress(rng));
  return out;
}

/** A body that `initializeSchema` must accept. */
function validInitializeBody(rng) {
  const n = rng.int(1, MAX_COLLABORATORS);
  return {
    contractId: validContractAddress(rng),
    walletAddress: validStellarAddress(rng),
    collaborators: distinctAddresses(rng, n),
    shares: exactShares(n),
  };
}

/** POST /api/v1/initialize */
export function initializeBody(rng) {
  const valid = validInitializeBody(rng);
  const mutation = rng.weighted([
    ["none", 4],
    ["bad-contract", 2],
    ["bad-wallet", 2],
    ["bad-collaborator", 2],
    ["shares-mismatch-length", 2],
    ["shares-wrong-sum", 3],
    ["shares-boundary", 2],
    ["too-many", 2],
    ["empty-lists", 2],
    ["missing-field", 3],
    ["extra-field", 2],
    ["wrong-type", 3],
    ["oversized", 2],
    ["nested", 2],
  ]);

  switch (mutation) {
    case "none":
      return { body: valid, expectValid: true };
    case "bad-contract":
      return { body: { ...valid, contractId: malformedContractAddress(rng) }, expectValid: false };
    case "bad-wallet":
      return { body: { ...valid, walletAddress: malformedStellarAddress(rng) }, expectValid: false };
    case "bad-collaborator": {
      const collaborators = [...valid.collaborators];
      collaborators[rng.int(0, collaborators.length - 1)] = malformedStellarAddress(rng);
      return { body: { ...valid, collaborators }, expectValid: false };
    }
    case "shares-mismatch-length":
      // Same sum, different arity — the length refinement is the only guard.
      return { body: { ...valid, shares: exactShares(valid.shares.length + 1) }, expectValid: false };
    case "shares-wrong-sum": {
      const shares = [...valid.shares];
      const delta = rng.weighted([
        [1, 3],
        [-1, 3],
        [10000, 1],
        [-10000, 1],
        [rng.int(-500, 500), 2],
      ]);
      shares[rng.int(0, shares.length - 1)] += delta;
      return { body: { ...valid, shares }, expectValid: shares.reduce((a, b) => a + b, 0) === 10000 };
    }
    case "shares-boundary": {
      const shares = valid.shares.map(() => basisPointsValue(rng));
      return { body: { ...valid, shares }, expectValid: false };
    }
    case "too-many": {
      const n = rng.int(MAX_COLLABORATORS + 1, MAX_COLLABORATORS + 12);
      return {
        body: { ...valid, collaborators: distinctAddresses(rng, n), shares: exactShares(n) },
        expectValid: false,
      };
    }
    case "empty-lists":
      return { body: { ...valid, collaborators: [], shares: [] }, expectValid: false };
    case "missing-field": {
      const body = { ...valid };
      delete body[rng.pick(["contractId", "walletAddress", "collaborators", "shares"])];
      return { body, expectValid: false };
    }
    case "extra-field":
      // Unknown keys must not smuggle through or break parsing; zod strips them.
      return {
        body: { ...valid, [rng.pick(["__proto__", "constructor", "admin", "isAdmin"])]: true },
        expectValid: true,
      };
    case "wrong-type": {
      const body = { ...valid };
      body[rng.pick(["contractId", "walletAddress", "collaborators", "shares"])] =
        unexpectedType(rng);
      return { body, expectValid: false };
    }
    case "oversized":
      return { body: { ...valid, contractId: oversizedString(rng) }, expectValid: false };
    case "nested":
      return { body: { ...valid, collaborators: deeplyNested(rng) }, expectValid: false };
    default:
      return { body: valid, expectValid: true };
  }
}

/** A distribution amount the schema must accept: positive number or digit string. */
function validAmount(rng) {
  return rng.weighted([
    [rng.int(1, 1_000_000), 3],
    [String(rng.int(1, 1_000_000)), 3],
    [1, 1],
    ["1", 1],
    [Number.MAX_SAFE_INTEGER, 1],
    [undefined, 2], // amount is optional
  ]);
}

/** POST /api/v1/distribute */
export function distributeBody(rng) {
  const valid = {
    contractId: validContractAddress(rng),
    walletAddress: validStellarAddress(rng),
    tokenId: validContractAddress(rng),
    amount: validAmount(rng),
  };
  if (valid.amount === undefined) delete valid.amount;

  const mutation = rng.weighted([
    ["none", 4],
    ["amount-zero", 2],
    ["amount-negative", 2],
    ["amount-fractional", 2],
    ["amount-string-junk", 3],
    ["amount-leading-zero", 2],
    ["amount-non-finite", 2],
    ["bad-token", 2],
    ["bad-contract", 2],
    ["missing-field", 2],
    ["wrong-type", 2],
    ["oversized", 1],
  ]);

  switch (mutation) {
    case "none":
      return { body: valid, expectValid: true };
    case "amount-zero":
      return { body: { ...valid, amount: rng.pick([0, "0", -0]) }, expectValid: false };
    case "amount-negative":
      return { body: { ...valid, amount: rng.pick([-1, "-1", -1000]) }, expectValid: false };
    case "amount-fractional": {
      // The union accepts any positive *number*, but the string branch is
      // integer-only — so 1.5 passes and "1.5" does not. That asymmetry is
      // deliberate in the schema; generate both sides so it stays pinned.
      const amount = rng.pick([1.5, 0.1, "1.5", "0.1"]);
      return { body: { ...valid, amount }, expectValid: typeof amount === "number" };
    }
    case "amount-string-junk": {
      // hostileString can return a non-string via its unexpected-type branch,
      // and `undefined` there means "field absent" to an `.optional()` schema
      // — a legitimate accept rather than a junk value.
      const amount = hostileString(rng, { maxLength: 32 });
      return { body: { ...valid, amount }, expectValid: amount === undefined };
    }
    case "amount-leading-zero":
      // "007" is a plausible client bug; the regex must reject it.
      return { body: { ...valid, amount: rng.pick(["007", "0", "0x10", "1e3", " 1", "1 "]) }, expectValid: false };
    case "amount-non-finite":
      return { body: { ...valid, amount: rng.pick([NaN, Infinity, -Infinity]) }, expectValid: false };
    case "bad-token":
      return { body: { ...valid, tokenId: malformedContractAddress(rng) }, expectValid: false };
    case "bad-contract":
      return { body: { ...valid, contractId: malformedContractAddress(rng) }, expectValid: false };
    case "missing-field": {
      const body = { ...valid };
      delete body[rng.pick(["contractId", "walletAddress", "tokenId"])];
      return { body, expectValid: false };
    }
    case "wrong-type": {
      const body = { ...valid };
      const field = rng.pick(["contractId", "walletAddress", "tokenId", "amount"]);
      const injected = unexpectedType(rng);
      body[field] = injected;
      // `amount` is `.optional()`, so an explicit `undefined` is the one
      // "wrong type" the schema legitimately accepts — it is indistinguishable
      // from the field being absent.
      const stillValid = field === "amount" && injected === undefined;
      return { body, expectValid: stillValid };
    }
    case "oversized":
      return { body: { ...valid, tokenId: oversizedString(rng) }, expectValid: false };
    default:
      return { body: valid, expectValid: true };
  }
}

/** POST /api/v1/batch-distribute */
export function batchDistributeBody(rng) {
  const count = rng.weighted([
    [rng.int(1, 5), 4],
    [1, 2],
    [MAX_BATCH_OPERATIONS, 2],
    [MAX_BATCH_OPERATIONS + 1, 2],
    [0, 2],
    [rng.int(MAX_BATCH_OPERATIONS + 2, MAX_BATCH_OPERATIONS + 20), 1],
  ]);

  const operations = Array.from({ length: Math.max(count, 0) }, () => {
    const op = {
      contractId: validContractAddress(rng),
      tokenId: validContractAddress(rng),
      amount: validAmount(rng),
    };
    if (op.amount === undefined) delete op.amount;
    return op;
  });

  const body = { walletAddress: validStellarAddress(rng), operations };
  const withinBounds = count >= 1 && count <= MAX_BATCH_OPERATIONS;

  const mutation = rng.weighted([
    ["none", 5],
    ["corrupt-one-op", 3],
    ["ops-not-array", 2],
    ["bad-wallet", 2],
    ["nested-ops", 2],
  ]);

  switch (mutation) {
    case "corrupt-one-op": {
      if (operations.length === 0) return { body, expectValid: false };
      const index = rng.int(0, operations.length - 1);
      operations[index] = { ...operations[index], contractId: malformedContractAddress(rng) };
      return { body, expectValid: false };
    }
    case "ops-not-array":
      return { body: { ...body, operations: unexpectedType(rng) }, expectValid: false };
    case "bad-wallet":
      return { body: { ...body, walletAddress: malformedStellarAddress(rng) }, expectValid: false };
    case "nested-ops":
      return { body: { ...body, operations: [deeplyNested(rng)] }, expectValid: false };
    default:
      return { body, expectValid: withinBounds };
  }
}

/** POST /api/v1/secondary-royalty/record */
export function recordSecondarySaleBody(rng) {
  const valid = {
    contractId: validContractAddress(rng),
    walletAddress: validStellarAddress(rng),
    nftId: rng.array(rng.int(1, 32), () => "N").join(""),
    previousOwner: validStellarAddress(rng),
    newOwner: validStellarAddress(rng),
    salePrice: rng.int(1, 1_000_000),
    saleToken: validContractAddress(rng),
    royaltyRate: rng.int(0, 10000),
  };

  const mutation = rng.weighted([
    ["none", 4],
    ["nft-empty", 2],
    ["nft-max", 2],
    ["nft-over-max", 3],
    ["price-zero", 2],
    ["price-negative", 2],
    ["price-fractional", 2],
    ["price-over-max", 3],
    ["rate-boundary", 3],
    ["bad-owner", 2],
    ["missing-field", 2],
    ["wrong-type", 2],
  ]);

  switch (mutation) {
    case "none":
      return { body: valid, expectValid: true };
    case "nft-empty":
      return { body: { ...valid, nftId: "" }, expectValid: false };
    case "nft-max":
      return { body: { ...valid, nftId: "N".repeat(MAX_NFT_ID_LENGTH) }, expectValid: true };
    case "nft-over-max":
      return {
        body: { ...valid, nftId: "N".repeat(rng.int(MAX_NFT_ID_LENGTH + 1, MAX_NFT_ID_LENGTH + 64)) },
        expectValid: false,
      };
    case "price-zero":
      return { body: { ...valid, salePrice: 0 }, expectValid: false };
    case "price-negative":
      return { body: { ...valid, salePrice: -rng.int(1, 1000) }, expectValid: false };
    case "price-fractional":
      return { body: { ...valid, salePrice: rng.pick([1.5, 0.1, 1e-7]) }, expectValid: false };
    case "price-over-max":
      // MAX_SALE_PRICE + 1 is not representable — it rounds back to the max.
      // The schema must not accept a value it cannot round-trip.
      return {
        body: { ...valid, salePrice: rng.pick([MAX_SALE_PRICE + 2, 1e17, Infinity, NaN]) },
        expectValid: false,
      };
    case "rate-boundary":
      return { body: { ...valid, royaltyRate: basisPointsValue(rng) }, expectValid: false };
    case "bad-owner":
      return {
        body: { ...valid, [rng.pick(["previousOwner", "newOwner"])]: malformedStellarAddress(rng) },
        expectValid: false,
      };
    case "missing-field": {
      const body = { ...valid };
      delete body[rng.pick(Object.keys(valid))];
      return { body, expectValid: false };
    }
    case "wrong-type": {
      const body = { ...valid };
      body[rng.pick(Object.keys(valid))] = unexpectedType(rng);
      return { body, expectValid: false };
    }
    default:
      return { body: valid, expectValid: true };
  }
}

/** GET query string for the pagination / analytics validators. */
export function paginationQuery(rng) {
  const query = {};
  if (rng.bool(0.8)) {
    query.limit = rng.weighted([
      [String(rng.int(1, 100)), 4],
      ["0", 2],
      ["-1", 2],
      ["101", 2],
      ["1e3", 2],
      ["abc", 2],
      ["", 2],
      [String(boundaryInteger(rng)), 2],
      [unexpectedType(rng), 1],
    ]);
  }
  if (rng.bool(0.5)) {
    query.cursor = rng.weighted([
      [Buffer.from(JSON.stringify({ timestamp: "2026-01-01T00:00:00Z", id: 1 })).toString("base64"), 3],
      [Buffer.from(JSON.stringify({ timestamp: "2026-01-01T00:00:00Z" })).toString("base64"), 2],
      [Buffer.from("not json").toString("base64"), 3],
      [Buffer.from(JSON.stringify(deeplyNested(rng, { maxDepth: 64 }))).toString("base64"), 2],
      ["!!!not-base64!!!", 3],
      ["", 2],
      [unexpectedType(rng), 1],
    ]);
  }
  return { query, expectValid: false };
}
