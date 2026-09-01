# Property-Based Fuzz Testing (#866)

Property-based fuzzing for the highest-risk input paths in the Stellar Royalty
Splitter backend: API request validation, contract invocation parameter
construction, and the serialization boundaries between them.

The existing suites validate known examples and known failures. This suite
generates large numbers of *structured but hostile* inputs and asserts
invariants that must hold for all of them.

> The Soroban contract already has its own property tests
> (`tests/property_tests.rs`, `tests/fuzz_royalty_allocation.rs`, run under
> `proptest`). This suite covers the JavaScript side, which had no equivalent.

---

## Running

All commands run from `backend/`.

```bash
npm run test:fuzz                # full run — 1 000 cases per property (~45 s)
FUZZ_SEED=123 npm run test:fuzz  # deterministic run under a fixed seed
FUZZ_CASES=200 npm run test:fuzz # reduced run, as CI uses on pull requests
FUZZ_CASES=50 npm run test:fuzz  # quick smoke run while iterating
```

On Windows `cmd`, set the variable first (`set FUZZ_SEED=123`); in PowerShell,
use `$env:FUZZ_SEED = "123"`. The scripts themselves are shell-agnostic — no
`cross-env` dependency is required.

| Variable | Default | Meaning |
|---|---|---|
| `FUZZ_SEED` | random per run (printed) | 32-bit seed. A fixed value makes the run fully reproducible. |
| `FUZZ_CASES` | `1000` | Generated cases per property. |
| `FUZZ_REPORT_DIR` | `tests/fuzz/reports` | Where the machine-readable run report is written. |

### Reproducing a failure

Every failure prints the reproduction command:

```
[fuzz] property "distributeSchema" failed
  case 44/1000
  reproduce this run:  FUZZ_SEED=1 npm run test:fuzz
  runSeed=1
  caseSeed=3118596494
  input={"body":{...,"amount":"Infinity"},"expectValid":false}
  failure: expect(received).toBe(expected)
```

- `runSeed` replays the **entire run**, case for case.
- `caseSeed` rebuilds that **single input** in isolation — each case draws its
  own seed from the run seed, so one case can be reconstructed without
  replaying the cases before it.
- `input` is the generated value itself, JSON-encoded.

---

## Layout

```
tests/fuzz/
├── random.js                 Seeded PRNG (mulberry32) + seed/case resolution
├── property.js               forAll() runner, settles(), deepEqual(), snapshot()
├── report.js                 Machine-readable run report writer
├── generators/
│   ├── primitives.js         Addresses, boundary integers, hostile strings,
│   │                         oversized payloads, deeply nested objects
│   └── payloads.js           Per-endpoint request-body generators
└── suites/
    ├── api-validation.fuzz.test.js            Zod schemas
    ├── contract-invocation.fuzz.test.js       ScVal builders, error parsing
    ├── serialization-boundaries.fuzz.test.js  Size guards, cursors, bps math
    └── regressions.fuzz.test.js               Fixed cases for found defects
```

Configuration lives in `backend/jest.fuzz.config.js`.

### Design notes

**Boundaries over noise.** A uniformly random 32-bit integer essentially never
lands on `0`, `10000`, or `MAX_SAFE_INTEGER` — and those are the values that
break basis-point arithmetic and payload caps. The generators draw mostly from
weighted tables of known-nasty constants, with a smaller share of free-form
randomness.

**Real APIs only.** Every suite imports the actual exported schemas, guards,
and builders. There are no test-only reimplementations, so a change to a schema
is exercised here immediately.

**No new dependencies.** The runner is ~150 lines on top of Jest. The contract
side already uses `proptest`; adding a second framework to the backend for this
would not have paid for itself.

**Valid inputs are generated too.** Roughly a third of generated cases are
well-formed. Invariants such as "an accepted split always sums to 10 000" and
"an accepted amount round-trips exactly" only have teeth if valid inputs
actually reach them.

---

## Invariants

Each is documented in full at the top of its suite file; summarised here.

### API request validation — `api-validation.fuzz.test.js`

| | Invariant |
|---|---|
| V1 | `safeParse` settles for every input — never crashes, never throws a non-Error |
| V2 | Parsing the same input twice yields the same verdict |
| V3 | Validation does not mutate the caller's object |
| V4 | Every rejection carries at least one issue with a path and a message |
| V5 | Accepted output satisfies every documented constraint — addresses well-formed, shares sum to 10 000, list lengths under their caps |
| V6 | Accepted output survives a JSON round trip without any value changing |

### Contract invocation — `contract-invocation.fuzz.test.js`

| | Invariant |
|---|---|
| C1 | Every ScVal builder settles on every input |
| C2 | A rejected input throws; it never yields a half-built ScVal |
| C3 | Any accepted value round-trips back to exactly itself |
| C4 | Every accepted ScVal encodes to XDR and decodes back identically |
| C5 | Builders do not mutate their arguments |
| C6 | `parseSorobanError` never throws; when it classifies, the envelope is actionable (`null` is its documented "unrecognised" sentinel) |

### Serialization and boundaries — `serialization-boundaries.fuzz.test.js`

| | Invariant |
|---|---|
| S1 | Every guard settles — including on deeply nested, oversized, and wrong-typed input |
| S2 | A guard either calls `next()` or writes a response — never both, never neither |
| S3 | Rejections carry a 4xx status and a machine-readable code |
| S4 | Size rejection is monotonic: if a payload is too large, every larger one is too |
| S5 | `encodeCursor` output always decodes back to the same `{timestamp, id}` |
| S6 | Cursor decoding is total over arbitrary attacker-supplied strings |
| S7 | Basis-point splits conserve value; dust is bounded by the recipient count |

---

## Coverage

| Target area (from #866) | Where |
|---|---|
| Contract function parameters | `contract-invocation` — `addressToScVal`, `u32ToScVal`, `i128ToScVal`, `bytes32ToScVal` |
| Transaction arguments | `contract-invocation` — `vecToScVal` argument vectors |
| API request bodies | `api-validation` — initialize, distribute, batch-distribute, secondary-sale |
| Numeric boundaries | `primitives.boundaryInteger`, `basisPointsValue`, S7 |
| Missing and optional fields | `payloads` — `missing-field` mutation |
| Invalid Stellar addresses | `primitives.malformedStellarAddress` — 16 distinct malformations |
| Invalid asset identifiers | `primitives.malformedContractAddress` |
| Oversized strings and payloads | `primitives.oversizedString`, S4 |
| Deeply nested objects | `primitives.deeplyNested` (up to depth 2 000) |
| Unexpected data types | `primitives.unexpectedType` |
| Empty and null values | Woven through every generator |
| Malformed serialization input | `primitives.malformedJsonText`, S6 |

---

## Findings

Six defects were found and fixed while building this suite. Findings 1–4 have
deterministic regression tests in `suites/regressions.fuzz.test.js`; findings 5
and 6 are typos that ESLint and the module-import regression already catch, so
they need no separate test.

> **Note on the wider suite.** Finding 4 was blocking most of the existing
> backend tests from loading. Fixing it moves `npm test` from 52 failing / 27
> passing suites to 47 failing / 32 passing, and from 377 to 441 tests
> collected. The remaining 47 failures are pre-existing and out of scope for
> #866 — several are more typos of the same family (`TTLcollaborators`,
> `CACHE_WARM_LEAD_TIME_MS`, a duplicate `getMigrationVersion` declaration)
> that `npm run lint` reports as 12 errors on `main`.

### 1. `Infinity` accepted as a distribution amount — validation bypass

**Found by:** property `distributeSchema`, seed 1, case 44.
**Fixed in:** `backend/src/validation.js` — `amountSchema`.

`z.number().positive()` is implemented as a `> 0` comparison, and
`Infinity > 0` is `true`. The amount union therefore accepted `Infinity` on
`/distribute`, `/batch-distribute`, and the secondary-royalty distribute path.
It was normalised straight through and only failed later inside `i128ToScVal`,
where `BigInt(Infinity)` throws a `RangeError` during transaction
construction — turning a malformed request into a 500 on a money-moving path
instead of a 400 at the edge.

Adding `.finite()` to the numeric branch closes it. `NaN` and `-Infinity` were
already rejected by the `> 0` test; `Infinity` was the only value that slipped
through.

### 2. `i128ToScVal` silently wrapped out-of-range amounts — value corruption

**Found by:** property `i128ToScVal`, seed 1.
**Fixed in:** `backend/src/stellar.js` — `i128ToScVal`.

`nativeToScVal(v, {type: "i128"})` does not range-check. An amount of `2^127`
encoded to valid XDR that decoded back as `-2^127`:

```
 170141183460469231731687303715884105728  ->  -170141183460469231731687303715884105728
-170141183460469231731687303715884105729  ->   170141183460469231731687303715884105727
```

No error was raised anywhere. The transaction was well-formed and carried the
wrong amount with the wrong **sign** — precisely the "silently corrupted
output" failure the issue calls out. `i128ToScVal` now range-checks and throws
a `RangeError` before encoding.

### 3. Identifier guards threw on non-string input — uncaught crash

**Found by:** property `identifierGuards`, seed 1.
**Fixed in:** `backend/src/validation.js` — `validateContractId`,
`validateContractIdMiddleware`, `validateStellarAddress`.

`RegExp.prototype.test` coerces its argument to a string, and that coercion
throws a `TypeError` for a symbol. All three guards called `.test()` on an
unvalidated value, so a non-string reaching them raised instead of returning a
400 — an uncaught throw on the untrusted-input path, which Express surfaces as
a 500. Each guard now checks `typeof … === "string"` first.

`validateContractIdMiddleware` and `validateContractId` enforce the same rule
and are used by different routes; the fuzz property cross-checks that they
always agree, since a divergence between them would be a validation bypass.

### 4. `backend/src/metrics.js` was syntactically invalid

**Found by:** wiring the fuzz suite — the module could not be imported.
**Fixed in:** `backend/src/metrics.js` line 3.

`import https ifrom "https"` — a stray `i`. Because routes and the app entry
point import `metrics.js` transitively, this broke module loading for the
majority of the existing backend Jest suites (52 of 79 suites failed to run on
`main` before this fix).

### 5. `ALERT_HISToRY_MS` typo in `metrics.js`

**Found by:** the regression test added for finding 4.
**Fixed in:** `backend/src/metrics.js` line 91.

Declared as `ALERT_HISToRY_MS` (lowercase `o`), used as `ALERT_HISTORY_MS`.
Masked by finding 4 — with the parse error fixed, importing the module threw
`ReferenceError: ALERT_HISTORY_MS is not defined` at evaluation time.

### 6. `DEFAULT_DETUPE_WINDOW_MS` typo in `metrics.js`

**Found by:** ESLint, once finding 4 made the file parseable.
**Fixed in:** `backend/src/metrics.js` line 168.

`DEFAULT_DEDUPE_WINDOW_MS` is declared, but the alert-rule normaliser read
`DEFAULT_DETUPE_WINDOW_MS`. Any alert rule omitting `dedupeWindowMs` would have
thrown a `ReferenceError` at rule-registration time. Unreachable while the file
could not be parsed at all, and invisible to ESLint for the same reason.

### Explicitly not treated as defects

Two behaviours were investigated and found correct:

- **`parseSorobanError` returns `null` for unrecognised shapes.** This is a
  documented sentinel, not a gap — its only caller substitutes a generic 500
  via `??`. The invariant was narrowed to "never throws".
- **Addresses with surrounding whitespace are accepted.**
  `shared/stellar-address.js` trims before validating, by design. Noted here
  because callers keep the *untrimmed* string; worth revisiting if an address
  is ever used as a storage key, but out of scope for this issue.

---

## CI

`.github/workflows/fuzz-ci.yml` runs a reduced subset on every pull request
touching the backend, the shared modules, or this directory:

- **Pull requests** — 200 cases per property, random seed, ~1 minute.
- **Nightly** — the full 1 000-case run under a random seed, so new input space
  is explored over time.

Both upload `tests/fuzz/reports/*.json` as an artifact. Each report records the
properties that ran, their case counts, and the seed used — so a green run can
be audited after the fact rather than taken on trust.

When CI reports a failure, copy the `FUZZ_SEED` from the log and run it
locally; the run reproduces exactly.

## Adding a property

1. Add or extend a generator in `generators/`, favouring boundary values.
2. Call `forAll({ name, generate, check })` in the relevant suite.
3. State the invariant in the suite's header comment — *what* must hold and
   *why it matters*, not just what the test does.
4. Pass the `forAll` return value to `recordRun(name, run)` so the property
   appears in the report.
5. If it uncovers a defect, minimise it into `suites/regressions.fuzz.test.js`
   and document it under **Findings** above.
