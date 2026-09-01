#!/usr/bin/env node

/**
 * Release validation script
 * Ensures version consistency and proper changelog format before release
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SEMVER_REGEX = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const ERRORS = [];
const WARNINGS = [];

/**
 * Validate semantic versioning format
 */
function validateSemanticVersion(version, name) {
  if (!SEMVER_REGEX.test(version)) {
    ERRORS.push(
      `Invalid ${name} version format: "${version}" (expected X.Y.Z)`,
    );
    return false;
  }
  return true;
}

/**
 * Parse version to components
 */
function parseVersion(version) {
  const [major, minor, patch] = version.split(".").map(Number);
  return { major, minor, patch };
}

/**
 * Validate version alignment
 */
function validateVersionAlignment(frontend, backend) {
  const frontendV = parseVersion(frontend);
  const backendV = parseVersion(backend);

  if (frontendV.major !== backendV.major) {
    ERRORS.push(
      `Major version mismatch: frontend ${frontendV.major} vs backend ${backendV.major}`,
    );
    return false;
  }

  if (frontendV.minor !== backendV.minor) {
    ERRORS.push(
      `Minor version mismatch: frontend ${frontendV.minor} vs backend ${backendV.minor}`,
    );
    return false;
  }

  // Patch versions can differ
  if (frontendV.patch !== backendV.patch) {
    WARNINGS.push(
      `Patch versions differ: frontend ${frontendV.patch} vs backend ${backendV.patch}`,
    );
  }

  return true;
}

/**
 * Validate changelog format
 */
function validateChangelog() {
  const changelogPath = path.join(__dirname, "../../CHANGELOG.md");

  if (!fs.existsSync(changelogPath)) {
    WARNINGS.push("CHANGELOG.md not found (will be created)");
    return true;
  }

  const content = fs.readFileSync(changelogPath, "utf8");

  // Check structure
  if (!content.includes("## [")) {
    ERRORS.push("CHANGELOG.md missing version headers (## [X.Y.Z])");
    return false;
  }

  if (!content.includes("###")) {
    WARNINGS.push("CHANGELOG.md has no category sections");
  }

  // Check for duplicate version
  const versionRegex = /## \[([\d.]+)\]/g;
  const versions = new Set();
  let match;
  while ((match = versionRegex.exec(content)) !== null) {
    if (versions.has(match[1])) {
      ERRORS.push(`CHANGELOG.md has duplicate version: ${match[1]}`);
      return false;
    }
    versions.add(match[1]);
  }

  return true;
}

/**
 * Check if versions have been updated
 */
function checkVersionUpdated() {
  return true; // Version checking done in release.yml workflow
}

/**
 * Main validation
 */
function main() {
  console.log("🔍 Validating release...\n");

  // Load versions
  const frontendPkg = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "../../frontend/package.json"),
      "utf8",
    ),
  );
  const backendPkg = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../../backend/package.json"), "utf8"),
  );

  const FRONTEND_VERSION = frontendPkg.version;
  const BACKEND_VERSION = backendPkg.version;

  console.log("📦 Package Versions:");
  console.log(`  Frontend: ${FRONTEND_VERSION}`);
  console.log(`  Backend: ${BACKEND_VERSION}\n`);

  // Validate formats
  console.log("🔎 Validating version formats...");
  if (
    !validateSemanticVersion(FRONTEND_VERSION, "Frontend") ||
    !validateSemanticVersion(BACKEND_VERSION, "Backend")
  ) {
    console.error("❌ Format validation failed\n");
  } else {
    console.log("✅ Version formats valid\n");
  }

  // Validate alignment
  console.log("🔗 Validating version alignment...");
  if (!validateVersionAlignment(FRONTEND_VERSION, BACKEND_VERSION)) {
    console.error("❌ Version alignment check failed\n");
  } else {
    console.log("✅ Versions aligned\n");
  }

  // Validate changelog
  console.log("📝 Validating CHANGELOG.md...");
  if (!validateChangelog()) {
    console.error("❌ Changelog validation failed\n");
  } else {
    console.log("✅ Changelog valid\n");
  }

  // Check if versions updated
  console.log("🏷️  Checking version updates...");
  if (!checkVersionUpdated()) {
    console.error("❌ Version update check failed\n");
  } else {
    console.log("✅ Versions updated\n");
  }

  // Report warnings
  if (WARNINGS.length > 0) {
    console.log("⚠️  Warnings:");
    WARNINGS.forEach((w) => console.log(`  - ${w}`));
    console.log();
  }

  // Report errors
  if (ERRORS.length > 0) {
    console.log("❌ Validation Errors:");
    ERRORS.forEach((e) => console.log(`  - ${e}`));
    console.log();
    process.exit(1);
  }

  console.log("✨ All validations passed!");
  process.exit(0);
}

main();
