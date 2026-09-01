/**
 * Deterministic pseudo-random source for the fuzz suite (#866).
 *
 * Property-based testing is only useful in CI if a failure can be replayed
 * byte-for-byte. Every generator in `generators/` draws from an instance of
 * this class, and every suite prints the seed it ran under, so a red build
 * can always be reproduced locally with:
 *
 *   FUZZ_SEED=<seed from the failure output> npm run test:fuzz
 *
 * Implementation is a 32-bit xorshift (mulberry32). It is intentionally not
 * cryptographic — it only needs to be uniform enough to explore input space
 * and, crucially, to be reproducible from a single 32-bit seed.
 */

const UINT32 = 0x100000000;

export class Rng {
  /** @param {number} seed 32-bit unsigned seed. */
  constructor(seed) {
    this.seed = seed >>> 0;
    this.state = this.seed;
  }

  /** Next float in [0, 1). */
  next() {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / UINT32;
  }

  /** Integer in [min, max] inclusive. */
  int(min, max) {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** True with probability `p`. */
  bool(p = 0.5) {
    return this.next() < p;
  }

  /** Uniformly pick one element of a non-empty array. */
  pick(items) {
    return items[this.int(0, items.length - 1)];
  }

  /**
   * Pick one element using integer weights, e.g.
   * `weighted([[a, 3], [b, 1]])` returns `a` three times as often as `b`.
   */
  weighted(entries) {
    const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
    let roll = this.next() * total;
    for (const [value, weight] of entries) {
      roll -= weight;
      if (roll < 0) return value;
    }
    return entries[entries.length - 1][0];
  }

  /** Array of `count` values produced by `fn`. */
  array(count, fn) {
    return Array.from({ length: count }, (_, i) => fn(i));
  }
}

/**
 * Resolve the seed for a run. An explicit FUZZ_SEED always wins so a reported
 * failure replays exactly; otherwise a fresh seed is drawn and printed, which
 * is what lets scheduled CI runs explore new input space over time.
 */
export function resolveSeed() {
  const fromEnv = process.env.FUZZ_SEED;
  if (fromEnv !== undefined && fromEnv !== "") {
    const parsed = Number.parseInt(fromEnv, 10);
    if (!Number.isFinite(parsed)) {
      throw new Error(`FUZZ_SEED must be an integer, received: ${fromEnv}`);
    }
    return parsed >>> 0;
  }
  return (Math.random() * UINT32) >>> 0;
}

/**
 * Number of generated cases per property. Defaults to the 1 000 required by
 * #866; CI lowers it for the pull-request subset via FUZZ_CASES so the job
 * stays inside its time budget while the nightly run uses the full count.
 */
export function resolveCases(fallback = 1000) {
  const fromEnv = process.env.FUZZ_CASES;
  if (fromEnv === undefined || fromEnv === "") return fallback;
  const parsed = Number.parseInt(fromEnv, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`FUZZ_CASES must be a positive integer, received: ${fromEnv}`);
  }
  return parsed;
}
