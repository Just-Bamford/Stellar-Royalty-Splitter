/**
 * Jest configuration for the property-based fuzz suite (#866).
 *
 * Kept separate from the inline `jest` block in package.json so the fuzz run
 * can differ from the unit run in the ways that matter:
 *
 *  - `rootDir` is the repository root, because the suites live in tests/fuzz/
 *    but import from backend/src/ and shared/.
 *  - a longer timeout, since a single property executes 1 000 cases.
 *  - `maxWorkers: 1`, so the seed printed on failure is the seed that
 *    produced it; parallel workers would interleave output and make a
 *    reported reproduction command ambiguous.
 *  - no coverage collection — coverage instrumentation roughly triples the
 *    cost of a 1 000-case property and tells us nothing the unit suite
 *    doesn't already report.
 *
 * Run with `npm run test:fuzz` from backend/.
 */

export default {
  rootDir: "..",
  testEnvironment: "node",
  testMatch: ["<rootDir>/tests/fuzz/suites/**/*.fuzz.test.js"],
  transform: {},
  // rootDir is the repo root, but the dependency tree lives under backend/.
  // Without this, shared/stellar-address.js cannot resolve @stellar/stellar-sdk.
  moduleDirectories: ["<rootDir>/backend/node_modules", "node_modules"],
  // The fuzz suites never touch the database; the mock keeps the import graph
  // resolvable without requiring the native better-sqlite3 build.
  moduleNameMapper: {
    "^better-sqlite3$": "<rootDir>/backend/__mocks__/better-sqlite3.js",
  },
  testTimeout: 120000,
  maxWorkers: 1,
  verbose: true,
};
