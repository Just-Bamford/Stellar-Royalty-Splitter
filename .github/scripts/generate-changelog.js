#!/usr/bin/env node

/**
 * Changelog generator for Stellar Royalty Splitter
 * Generates changelog entries from git commits and PR metadata
 * Validates and updates CHANGELOG.md with structured entries
 */

import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Read current versions
const frontendPkg = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../../frontend/package.json"), "utf8"),
);
const backendPkg = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../../backend/package.json"), "utf8"),
);

const FRONTEND_VERSION = frontendPkg.version;
const BACKEND_VERSION = backendPkg.version;
const RELEASE_DATE = new Date().toISOString().split("T")[0];

/**
 * Get commits since last tag
 */
function getCommitsSinceLastTag() {
  try {
    // Get last tag
    const lastTag = execSync(
      "git describe --tags --abbrev=0 2>/dev/null || echo 'HEAD~20'",
    )
      .toString()
      .trim();

    // Get commits between last tag and HEAD
    const commits = execSync(
      `git log ${lastTag}..HEAD --oneline --format="%H|%s|%b"`,
    )
      .toString()
      .trim()
      .split("\n")
      .filter(Boolean);

    return commits.map((line) => {
      const [hash, subject, body] = line.split("|");
      return { hash: hash.slice(0, 7), subject, body: body || "" };
    });
  } catch (err) {
    console.warn("Could not get commits:", err.message);
    return [];
  }
}

/**
 * Categorize commits by type
 */
function categorizeCommits(commits) {
  const categories = {
    features: [],
    fixes: [],
    breaking: [],
    performance: [],
    chore: [],
  };

  commits.forEach((commit) => {
    const subject = commit.subject.toLowerCase();

    if (subject.includes("breaking") || subject.includes("breaking change")) {
      categories.breaking.push(commit);
    } else if (subject.startsWith("feat") || subject.includes("feature")) {
      categories.features.push(commit);
    } else if (subject.startsWith("fix") || subject.includes("bug")) {
      categories.fixes.push(commit);
    } else if (subject.includes("perf") || subject.includes("performance")) {
      categories.performance.push(commit);
    } else {
      categories.chore.push(commit);
    }
  });

  return categories;
}

/**
 * Format changelog entry
 */
function formatChangelogEntry(version, date, categories) {
  let entry = `## [${version}] - ${date}\n\n`;

  if (categories.breaking.length > 0) {
    entry += `### ⚠️ Breaking Changes\n`;
    categories.breaking.forEach((c) => {
      entry += `- ${c.subject} (${c.hash})\n`;
    });
    entry += "\n";
  }

  if (categories.features.length > 0) {
    entry += `### ✨ Features\n`;
    categories.features.forEach((c) => {
      entry += `- ${c.subject} (${c.hash})\n`;
    });
    entry += "\n";
  }

  if (categories.fixes.length > 0) {
    entry += `### 🐛 Bug Fixes\n`;
    categories.fixes.forEach((c) => {
      entry += `- ${c.subject} (${c.hash})\n`;
    });
    entry += "\n";
  }

  if (categories.performance.length > 0) {
    entry += `### ⚡ Performance\n`;
    categories.performance.forEach((c) => {
      entry += `- ${c.subject} (${c.hash})\n`;
    });
    entry += "\n";
  }

  if (categories.chore.length > 0 && categories.chore.length <= 5) {
    entry += `### 🔧 Chores\n`;
    categories.chore.forEach((c) => {
      entry += `- ${c.subject} (${c.hash})\n`;
    });
    entry += "\n";
  }

  // Add version info
  entry += `### Version Info\n`;
  entry += `- Frontend: v${FRONTEND_VERSION}\n`;
  entry += `- Backend: v${BACKEND_VERSION}\n\n`;

  return entry;
}

/**
 * Validate changelog structure
 */
function validateChangelog(content) {
  const errors = [];

  if (!content.includes("## [")) {
    errors.push("Missing version headers");
  }

  if (!content.includes("###")) {
    errors.push("Missing section headers");
  }

  // Check for unreleased section
  if (!content.includes("## [Unreleased]")) {
    console.warn("No [Unreleased] section found. Creating one.");
  }

  return errors;
}

/**
 * Main execution
 */
function main() {
  console.log("🔄 Generating changelog...");
  console.log(`Frontend version: ${FRONTEND_VERSION}`);
  console.log(`Backend version: ${BACKEND_VERSION}`);
  console.log(`Release date: ${RELEASE_DATE}`);

  // Get commits
  const commits = getCommitsSinceLastTag();
  console.log(`Found ${commits.length} commits since last tag`);

  if (commits.length === 0) {
    console.warn("⚠️  No commits found. Creating minimal changelog entry.");
  }

  // Categorize
  const categories = categorizeCommits(commits);

  // Format entry
  const entry = formatChangelogEntry(
    FRONTEND_VERSION,
    RELEASE_DATE,
    categories,
  );

  // Read existing changelog
  const changelogPath = path.join(__dirname, "../../CHANGELOG.md");
  let existingContent = "";
  if (fs.existsSync(changelogPath)) {
    existingContent = fs.readFileSync(changelogPath, "utf8");
  }

  // Validate existing
  const validationErrors = validateChangelog(existingContent);
  if (validationErrors.length > 0) {
    console.warn("⚠️  Validation warnings:");
    validationErrors.forEach((err) => console.warn(`  - ${err}`));
  }

  // Prepare new changelog
  let newChangelog = entry;
  if (existingContent) {
    newChangelog += existingContent;
  } else {
    newChangelog += `# Changelog\n\nAll notable changes to this project will be documented in this file.\n\n`;
  }

  // Write changelog
  fs.writeFileSync(changelogPath, newChangelog);
  console.log("✅ CHANGELOG.md updated");

  // Write entry for release
  fs.writeFileSync(path.join(__dirname, "../../CHANGELOG_ENTRY.md"), entry);
  console.log("✅ CHANGELOG_ENTRY.md created");

  // Summary
  console.log("\n📋 Changelog Summary:");
  console.log(`  Features: ${categories.features.length}`);
  console.log(`  Fixes: ${categories.fixes.length}`);
  console.log(`  Breaking: ${categories.breaking.length}`);
  console.log(`  Performance: ${categories.performance.length}`);

  console.log("\n✨ Changelog generation complete");
}

main();
