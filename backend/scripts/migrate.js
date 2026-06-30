#!/usr/bin/env node
/**
 * Database migration CLI (#519).
 *
 * Usage:
 *   node scripts/migrate.js status            Show each migration and whether it is applied
 *   node scripts/migrate.js up                Apply all pending migrations
 *   node scripts/migrate.js up --to <version> Apply pending migrations up to <version>
 *   node scripts/migrate.js down              Roll back the most recently applied migration
 *   node scripts/migrate.js down --step <n>   Roll back the last <n> migrations
 *   node scripts/migrate.js down --to <version> Roll back until the current version is <version>
 *
 * The CLI operates on the same database and migration registry used at server
 * startup (src/database/core.js → src/database/migrations.js), so applying or
 * rolling back here is exactly what the boot path would do.
 */

import { db, closeDatabase } from "../src/database/core.js";
import {
  MIGRATIONS,
  migrateUp,
  migrateDown,
  getStatus,
  getCurrentVersion,
} from "../src/database/migrations.js";

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (token === "--to") flags.to = Number(rest[++i]);
    else if (token === "--step" || token === "--steps") flags.steps = Number(rest[++i]);
    else if (token.startsWith("--to=")) flags.to = Number(token.slice(5));
    else if (token.startsWith("--step=")) flags.steps = Number(token.slice(7));
  }
  return { command, flags };
}

function printStatus() {
  const rows = getStatus(db, MIGRATIONS);
  const current = getCurrentVersion(db);
  console.log(`Current schema version: ${current}\n`);
  console.log("  ver  status     name");
  console.log("  ---  ---------  ----------------------------------------");
  for (const r of rows) {
    const mark = r.applied ? "applied" : "pending";
    console.log(`  ${String(r.version).padStart(3)}  ${mark.padEnd(9)}  ${r.name}`);
  }
}

function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));

  switch (command) {
    case "status":
      printStatus();
      break;

    case "up": {
      const applied = migrateUp(db, { to: flags.to }, MIGRATIONS);
      if (applied.length === 0) {
        console.log("Database is already up to date. No migrations applied.");
      } else {
        console.log(`Applied ${applied.length} migration(s): ${applied.join(", ")}`);
      }
      console.log(`Current schema version: ${getCurrentVersion(db)}`);
      break;
    }

    case "down": {
      const reverted = migrateDown(db, { to: flags.to, steps: flags.steps }, MIGRATIONS);
      if (reverted.length === 0) {
        console.log("Nothing to roll back.");
      } else {
        console.log(`Rolled back ${reverted.length} migration(s): ${reverted.join(", ")}`);
      }
      console.log(`Current schema version: ${getCurrentVersion(db)}`);
      break;
    }

    default:
      console.error(
        `Unknown or missing command: ${command ?? "(none)"}\n\n` +
          "Usage: node scripts/migrate.js <status|up|down> [--to <version>] [--step <n>]",
      );
      process.exitCode = 1;
  }
}

try {
  main();
} catch (err) {
  console.error(`Migration command failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  closeDatabase();
}
