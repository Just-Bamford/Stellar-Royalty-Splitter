/**
 * Minimal property-test runner for the fuzz suite (#866).
 *
 * Why not a third-party framework: the contract side already uses `proptest`
 * (tests/property_tests.rs, tests/fuzz_royalty_allocation.rs) and the backend
 * deliberately ships no runtime fuzzing dependency. This runner gives the JS
 * side the three things #866 actually asks for — a fixed iteration count, a
 * reproducible seed, and failure output carrying the offending input — on top
 * of the Jest runner already used by `backend/tests/`.
 *
 * Reproduction contract: when a property fails, the thrown error names the
 * property, the case index, the run seed, the per-case seed, and the JSON of
 * the generated input. Re-running with `FUZZ_SEED=<run seed>` replays the run
 * exactly, and `caseSeed` alone is enough to rebuild that single input.
 */

import { Rng, resolveSeed, resolveCases } from "./random.js";

const MAX_INPUT_CHARS = 2000;

/** Render a generated input for a failure message without flooding the log. */
function describeInput(input) {
  let text;
  try {
    text = JSON.stringify(input, jsonSafeReplacer);
  } catch {
    text = String(input);
  }
  if (text === undefined) text = String(input);
  return text.length > MAX_INPUT_CHARS
    ? `${text.slice(0, MAX_INPUT_CHARS)}… [truncated, ${text.length} chars total]`
    : text;
}

/** JSON.stringify replacer that survives the hostile values the generators emit. */
function jsonSafeReplacer(_key, value) {
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value === "function") return "[Function]";
  if (typeof value === "symbol") return value.toString();
  if (value === undefined) return "[undefined]";
  if (typeof value === "number" && !Number.isFinite(value)) return String(value);
  return value;
}

/**
 * Run `check` against `cases` generated inputs.
 *
 * @param {object} options
 * @param {string} options.name        Property name, echoed in failures.
 * @param {(rng: Rng) => unknown} options.generate  Builds one input.
 * @param {(input: unknown, ctx: object) => void} options.check  Asserts the invariant.
 * @param {number} [options.cases]     Iterations; defaults to FUZZ_CASES or 1000.
 * @param {number} [options.seed]      Run seed; defaults to FUZZ_SEED or random.
 * @returns {{ seed: number, cases: number }} Run metadata for reporting.
 */
export function forAll({ name, generate, check, cases, seed }) {
  const runSeed = seed ?? resolveSeed();
  const iterations = cases ?? resolveCases();
  const seedRng = new Rng(runSeed);

  for (let index = 0; index < iterations; index += 1) {
    // Each case draws its own seed from the run seed, so a single case can be
    // rebuilt in isolation without replaying every case before it.
    const caseSeed = seedRng.int(0, 0xffffffff);
    const rng = new Rng(caseSeed);

    let input;
    try {
      input = generate(rng);
    } catch (error) {
      throw new Error(
        `[fuzz] generator threw while building a case for "${name}"\n` +
          `  runSeed=${runSeed} caseSeed=${caseSeed} case=${index}\n` +
          `  cause: ${error && error.stack ? error.stack : error}`
      );
    }

    try {
      check(input, { rng, caseSeed, runSeed, index });
    } catch (error) {
      throw new Error(
        `[fuzz] property "${name}" failed\n` +
          `  case ${index + 1}/${iterations}\n` +
          `  reproduce this run:  FUZZ_SEED=${runSeed} npm run test:fuzz\n` +
          `  runSeed=${runSeed}\n` +
          `  caseSeed=${caseSeed}\n` +
          `  input=${describeInput(input)}\n` +
          `  failure: ${error && error.message ? error.message : error}`,
        { cause: error }
      );
    }
  }

  return { seed: runSeed, cases: iterations };
}

/**
 * Assert that `fn` settles — returns or throws a normal Error — rather than
 * killing the process. Used by the "never an uncaught crash" invariants: a
 * thrown Error is an acceptable, observable rejection; a non-Error throw is
 * not, because it loses the diagnostic that operators would need.
 */
export function settles(fn) {
  try {
    return { ok: true, value: fn() };
  } catch (error) {
    if (!isErrorLike(error)) {
      throw new Error(
        `expected a thrown Error, got ${typeof error}: ${String(error)} ` +
          `(non-Error throws lose the stack an operator needs to triage)`
      );
    }
    return { ok: false, error };
  }
}

/**
 * Structural Error check.
 *
 * `instanceof Error` is unreliable here: Jest runs each suite in its own VM
 * realm, so an Error thrown by Node internals or by the Stellar SDK carries a
 * different `Error` constructor and fails the instanceof test even though it
 * is a perfectly ordinary error. Checking for the properties an operator
 * actually needs — a name, a message, and a stack — is both accurate across
 * realms and closer to what the invariant is really asserting.
 */
function isErrorLike(value) {
  if (value instanceof Error) return true;
  return (
    typeof value === "object" &&
    value !== null &&
    typeof value.message === "string" &&
    typeof value.name === "string" &&
    typeof value.stack === "string"
  );
}

/** Structural deep-equality good enough to detect caller-object mutation. */
export function deepEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;

  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => Object.hasOwn(b, key) && deepEqual(a[key], b[key]));
}

/**
 * Stable snapshot of a value, for before/after mutation comparison.
 *
 * `structuredClone` throws on functions and symbols, which the generators
 * deliberately produce as "unexpected type" inputs. Falling back to a manual
 * walk keeps those cases testable: the clone only needs to be faithful enough
 * for `deepEqual` to notice a mutation, and non-cloneable leaves are carried
 * through by reference (they are compared with Object.is anyway).
 */
export function snapshot(value) {
  try {
    return structuredClone(value);
  } catch {
    return manualClone(value, new WeakMap());
  }
}

function manualClone(value, seen) {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return seen.get(value);

  const copy = Array.isArray(value) ? [] : {};
  seen.set(value, copy);
  for (const key of Object.keys(value)) {
    copy[key] = manualClone(value[key], seen);
  }
  return copy;
}
