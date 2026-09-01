/**
 * Machine-readable run reporting for the fuzz suite (#866).
 *
 * Acceptance criteria require that generated failures carry reproduction
 * information and that results are documented. Jest's own output covers the
 * failure path; this module covers the success path, emitting one JSON file
 * per worker recording which properties ran, at what case count, and under
 * which seed — so a nightly CI run can be audited after the fact ("did the
 * 1 000-case suite actually run, or did FUZZ_CASES silently shrink it?").
 *
 * Writing is best-effort: a report that cannot be written must never turn a
 * passing suite red.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORT_DIR = process.env.FUZZ_REPORT_DIR || join(HERE, "reports");

const runs = [];
let flushScheduled = false;

/**
 * Record one completed property run.
 * @param {string} property Property name.
 * @param {{seed: number, cases: number}} result Value returned by `forAll`.
 */
export function recordRun(property, result) {
  runs.push({
    property,
    seed: result.seed,
    cases: result.cases,
    reproduce: `FUZZ_SEED=${result.seed} FUZZ_CASES=${result.cases} npm run test:fuzz`,
  });
  scheduleFlush();
}

function scheduleFlush() {
  if (flushScheduled) return;
  flushScheduled = true;
  // Flush on exit rather than per-run so each worker writes exactly one file.
  process.on("exit", flush);
}

function flush() {
  if (runs.length === 0) return;
  try {
    mkdirSync(REPORT_DIR, { recursive: true });
    const payload = {
      schemaVersion: 1,
      generatedAtEpochMs: Date.now(),
      node: process.version,
      platform: process.platform,
      totalCases: runs.reduce((sum, run) => sum + run.cases, 0),
      runs,
    };
    writeFileSync(
      join(REPORT_DIR, `fuzz-run-${process.pid}.json`),
      `${JSON.stringify(payload, null, 2)}\n`,
      "utf8"
    );
  } catch {
    // Reporting is diagnostic only — never fail a green run over it.
  }
}
