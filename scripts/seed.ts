#!/usr/bin/env -S npx tsx
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

const network = process.env.STELLAR_NETWORK ?? "testnet";
const identity = process.env.STELLAR_IDENTITY ?? "deployer";
const contractName = "stellar_royalty_splitter";
const wasmPath = `target/wasm32-unknown-unknown/release/${contractName}.wasm`;
const optimizedWasmPath = `target/wasm32-unknown-unknown/release/${contractName}.optimized.wasm`;

function run(command: string, args: string[], options: { quiet?: boolean } = {}) {
  if (!options.quiet) {
    console.log(`$ ${command} ${args.join(" ")}`);
  }
  return execFileSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
}

function requireCommand(command: string, args: string[]) {
  try {
    run(command, args, { quiet: true });
  } catch {
    throw new Error(`Required command not found or not working: ${command}`);
  }
}

function parseList(value: string | undefined, fallback: string[]) {
  if (!value) return fallback;
  const trimmed = value.trim();
  if (trimmed.startsWith("[")) return JSON.parse(trimmed);
  return trimmed.split(",").map((item) => item.trim()).filter(Boolean);
}

function parseNumberList(value: string | undefined, fallback: number[]) {
  return parseList(value, fallback.map(String)).map((item) => Number(item));
}

function updateEnvFile(contractId: string, tokenId: string) {
  const envPath = path.join(repoRoot, "backend", ".env");
  const existing = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  const lines = existing
    .split("\n")
    .filter((line) => !/^ROYALTY_CONTRACT_ID=/.test(line))
    .filter((line) => !/^ROYALTY_TOKEN_ID=/.test(line))
    .filter((line) => !/^STELLAR_NETWORK=/.test(line))
    .filter((line, index, all) => line.length > 0 || index < all.length - 1);

  lines.push(`ROYALTY_CONTRACT_ID=${contractId}`);
  lines.push(`ROYALTY_TOKEN_ID=${tokenId}`);
  lines.push(`STELLAR_NETWORK=${network}`);
  writeFileSync(envPath, `${lines.join("\n")}\n`);
}

if (network !== "testnet") {
  throw new Error("scripts/seed.ts is intended for Testnet only. Set STELLAR_NETWORK=testnet.");
}

requireCommand("cargo", ["--version"]);
requireCommand("stellar", ["--version"]);

try {
  run("stellar", ["keys", "show", identity], { quiet: true });
} catch {
  run("stellar", ["keys", "generate", "--global", identity, "--network", network]);
}

const adminAddress =
  process.env.SEED_ADMIN_ADDRESS ?? run("stellar", ["keys", "address", identity], { quiet: true });
const collaborators = parseList(process.env.SEED_COLLABORATORS, [adminAddress]);
const shares = parseNumberList(process.env.SEED_SHARES, [10_000]);
const royaltyRate = Number(process.env.SEED_ROYALTY_RATE_BPS ?? "500");
const tokenId =
  process.env.SEED_TOKEN_ID ??
  process.env.ROYALTY_TOKEN_ID ??
  process.env.TOKEN_CONTRACT_ID ??
  process.env.TOKEN_ID;
const fundAmount = process.env.SEED_FUND_AMOUNT ?? "10000000";

if (!tokenId) {
  throw new Error(
    "Set SEED_TOKEN_ID to the Testnet token contract ID used to fund the royalty contract.",
  );
}

if (collaborators.length !== shares.length) {
  throw new Error("SEED_COLLABORATORS and SEED_SHARES must have the same length.");
}

if (shares.reduce((sum, share) => sum + share, 0) !== 10_000) {
  throw new Error("SEED_SHARES must sum to 10000 basis points.");
}

if (!Number.isInteger(royaltyRate) || royaltyRate <= 0 || royaltyRate > 10_000) {
  throw new Error("SEED_ROYALTY_RATE_BPS must be an integer from 1 to 10000.");
}

console.log(`Seeding ${contractName} on ${network} with identity ${identity}`);
run("cargo", ["build", "--target", "wasm32-unknown-unknown", "--release"]);
run("stellar", ["contract", "optimize", "--wasm", wasmPath]);

const contractId = run("stellar", [
  "contract",
  "deploy",
  "--wasm",
  optimizedWasmPath,
  "--source",
  identity,
  "--network",
  network,
]);

run("stellar", [
  "contract",
  "invoke",
  "--id",
  contractId,
  "--source",
  identity,
  "--network",
  network,
  "--",
  "initialize",
  "--collaborators",
  JSON.stringify(collaborators),
  "--shares",
  JSON.stringify(shares),
]);

run("stellar", [
  "contract",
  "invoke",
  "--id",
  contractId,
  "--source",
  identity,
  "--network",
  network,
  "--",
  "set_royalty_rate",
  "--new_rate",
  String(royaltyRate),
]);

run("stellar", [
  "contract",
  "invoke",
  "--id",
  tokenId,
  "--source",
  identity,
  "--network",
  network,
  "--",
  "transfer",
  "--from",
  adminAddress,
  "--to",
  contractId,
  "--amount",
  fundAmount,
]);

writeFileSync(path.join(repoRoot, ".contract-id"), `${contractId}\n`);
updateEnvFile(contractId, tokenId);

console.log(`Seed complete. Contract: ${contractId}`);
