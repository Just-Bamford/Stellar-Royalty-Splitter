#!/usr/bin/env node
/**
 * Benchmark CLI (#867).
 *
 *   node benchmarks/index.js                          # run all, print a table
 *   node benchmarks/index.js --json results.json      # machine-readable output
 *   node benchmarks/index.js --filter validation      # one group
 *   node benchmarks/index.js --quick                  # 1/10 iterations
 *   node benchmarks/index.js --label "pr-1234"        # tag the result set
 *
 * Run via `npm run bench` from backend/.
 */

import { runAll, runBest, buildReport, writeReport, formatTable } from "./runner.js";
import validationScenarios from "./scenarios/validation.bench.js";
import serializationScenarios from "./scenarios/serialization.bench.js";
import httpScenarios from "./scenarios/http.bench.js";

const SCENARIOS = [...validationScenarios, ...serializationScenarios, ...httpScenarios];

function parseArgs(argv) {
  const args = { json: null, filter: null, quick: false, label: null, repeat: 1 };

  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case "--json":
        args.json = argv[++i];
        break;
      case "--filter":
        args.filter = argv[++i];
        break;
      case "--label":
        args.label = argv[++i];
        break;
      case "--repeat":
        args.repeat = Number(argv[++i]);
        break;
      case "--quick":
        args.quick = true;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }

  return args;
}

const USAGE = `
Usage: node benchmarks/index.js [options]

  --json <path>     Write machine-readable results to <path>
  --filter <text>   Only run scenarios whose name or group contains <text>
  --label <text>    Tag the result set (e.g. a PR number or commit sha)
  --repeat <n>      Run the suite n times and keep each scenario's best pass
  --quick           Run 1/10 of the configured iterations
  -h, --help        Show this message

Groups: validation, serialization, http
`.trim();

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  process.stderr.write(
    `Running ${args.filter ? `"${args.filter}" ` : ""}benchmarks` +
      `${args.quick ? " (quick mode)" : ""}…\n`
  );

  const results =
    args.repeat > 1
      ? await runBest(SCENARIOS, {
          filter: args.filter,
          quick: args.quick,
          repeat: args.repeat,
        })
      : await runAll(SCENARIOS, { filter: args.filter, quick: args.quick });
  const report = buildReport(results, { label: args.label });

  process.stdout.write(`\n${formatTable(results)}\n`);

  if (args.json) {
    writeReport(report, args.json);
    process.stderr.write(`\nWrote ${args.json}\n`);
  }

  if (args.quick) {
    process.stderr.write(
      "\nQuick mode uses 1/10 of the iterations — results are indicative only " +
        "and must not be committed as a baseline.\n"
    );
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
});
