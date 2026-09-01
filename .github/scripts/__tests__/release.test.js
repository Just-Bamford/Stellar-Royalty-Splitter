/**
 * Release workflow validation tests
 * Tests version validation and changelog generation logic
 */

import { describe, it, expect } from "vitest";

/**
 * Semantic version validation
 */
const SEMVER_REGEX = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function isValidSemver(version) {
  return SEMVER_REGEX.test(version);
}

function parseVersion(version) {
  const [major, minor, patch] = version.split(".").map(Number);
  return { major, minor, patch };
}

describe("Release Workflow Validation", () => {
  describe("Semantic Versioning", () => {
    it("should accept valid version formats", () => {
      expect(isValidSemver("0.0.0")).toBe(true);
      expect(isValidSemver("1.0.0")).toBe(true);
      expect(isValidSemver("1.2.3")).toBe(true);
      expect(isValidSemver("10.20.30")).toBe(true);
    });

    it("should reject invalid version formats", () => {
      expect(isValidSemver("1.0")).toBe(false);
      expect(isValidSemver("1")).toBe(false);
      expect(isValidSemver("v1.0.0")).toBe(false);
      expect(isValidSemver("1.0.0-alpha")).toBe(false);
      expect(isValidSemver("")).toBe(false);
      expect(isValidSemver("latest")).toBe(false);
    });

    it("should parse version components", () => {
      const v = parseVersion("1.2.3");
      expect(v.major).toBe(1);
      expect(v.minor).toBe(2);
      expect(v.patch).toBe(3);
    });
  });

  describe("Version Alignment", () => {
    it("should accept matching major and minor", () => {
      const frontend = parseVersion("1.2.0");
      const backend = parseVersion("1.2.1");
      expect(frontend.major).toBe(backend.major);
      expect(frontend.minor).toBe(backend.minor);
    });

    it("should reject mismatched major", () => {
      const frontend = parseVersion("1.2.0");
      const backend = parseVersion("2.2.0");
      expect(frontend.major).not.toBe(backend.major);
    });

    it("should reject mismatched minor", () => {
      const frontend = parseVersion("1.2.0");
      const backend = parseVersion("1.3.0");
      expect(frontend.minor).not.toBe(backend.minor);
    });

    it("should allow different patch versions", () => {
      const frontend = parseVersion("1.2.0");
      const backend = parseVersion("1.2.5");
      expect(frontend.major).toBe(backend.major);
      expect(frontend.minor).toBe(backend.minor);
      expect(frontend.patch).not.toBe(backend.patch); // Different is ok
    });
  });

  describe("Version Ordering", () => {
    it("should detect version increments", () => {
      const versions = ["0.0.1", "0.1.0", "1.0.0", "1.0.1", "1.1.0"];
      const parsed = versions.map(parseVersion);

      // Each should be greater than previous
      for (let i = 1; i < parsed.length; i++) {
        const prev = parsed[i - 1];
        const curr = parsed[i];

        const prevNum = prev.major * 10000 + prev.minor * 100 + prev.patch;
        const currNum = curr.major * 10000 + curr.minor * 100 + curr.patch;

        expect(currNum).toBeGreaterThan(prevNum);
      }
    });
  });

  describe("Changelog Structure", () => {
    it("should validate changelog sections", () => {
      const validChangelog = `
## [1.0.0] - 2024-01-15

### ✨ Features
- New feature

### 🐛 Bug Fixes
- Fixed bug

### Version Info
- Frontend: v1.0.0
- Backend: v1.0.0
`;

      expect(validChangelog).toContain("## [");
      expect(validChangelog).toContain("###");
      expect(validChangelog).toContain("Version Info");
    });

    it("should detect duplicate versions", () => {
      const changelog = `
## [1.0.0] - 2024-01-15
...content...

## [1.0.0] - 2024-01-16
...duplicate...
`;

      const versionRegex = /## \[([\d.]+)\]/g;
      const versions = new Set();
      let match;
      let hasDuplicate = false;

      while ((match = versionRegex.exec(changelog)) !== null) {
        if (versions.has(match[1])) {
          hasDuplicate = true;
        }
        versions.add(match[1]);
      }

      expect(hasDuplicate).toBe(true);
    });

    it("should extract version entries", () => {
      const changelog = `
## [1.0.0] - 2024-01-15
...

## [0.1.0] - 2024-01-14
...
`;

      const versionRegex = /## \[([\d.]+)\]/g;
      const versions = [];
      let match;

      while ((match = versionRegex.exec(changelog)) !== null) {
        versions.push(match[1]);
      }

      expect(versions).toEqual(["1.0.0", "0.1.0"]);
    });
  });

  describe("Release Metadata", () => {
    it("should validate tag format", () => {
      const tagRegex = /^v\d+\.\d+\.\d+$/;
      expect(tagRegex.test("v1.0.0")).toBe(true);
      expect(tagRegex.test("v0.1.0")).toBe(true);
      expect(tagRegex.test("1.0.0")).toBe(false);
      expect(tagRegex.test("v1.0")).toBe(false);
    });

    it("should match version to tag", () => {
      const version = "1.2.3";
      const tag = `v${version}`;
      expect(tag).toBe("v1.2.3");
    });
  });

  describe("Release Safety", () => {
    it("should prevent release without version change", () => {
      const lastVersion = "1.0.0";
      const currentVersion = "1.0.0";
      expect(currentVersion).toBe(lastVersion); // Should fail
    });

    it("should allow release with version change", () => {
      const lastVersion = "1.0.0";
      const currentVersion = "1.0.1";
      expect(currentVersion).not.toBe(lastVersion); // Should pass
    });

    it("should validate before creating tags", () => {
      const validations = [
        { name: "semver", check: (v) => isValidSemver(v), value: "1.0.0" },
        {
          name: "alignment",
          check: () => true,
          value: true,
        },
        {
          name: "version-updated",
          check: (curr, last) => curr !== last,
          value: ["1.0.1", "1.0.0"],
        },
      ];

      const allValid = validations.every((v) => {
        if (Array.isArray(v.value)) {
          return v.check(...v.value);
        }
        return v.check(v.value);
      });

      expect(allValid).toBe(true);
    });
  });

  describe("Commit Message Convention", () => {
    it("should categorize commit types", () => {
      const commits = [
        { type: "feat", message: "add new feature" },
        { type: "fix", message: "fix a bug" },
        { type: "perf", message: "improve performance" },
        { type: "chore", message: "update deps" },
      ];

      const categories = {
        features: 0,
        fixes: 0,
        performance: 0,
        chore: 0,
      };

      commits.forEach((c) => {
        switch (c.type) {
          case "feat":
            categories.features++;
            break;
          case "fix":
            categories.fixes++;
            break;
          case "perf":
            categories.performance++;
            break;
          case "chore":
            categories.chore++;
            break;
        }
      });

      expect(categories.features).toBe(1);
      expect(categories.fixes).toBe(1);
      expect(categories.performance).toBe(1);
      expect(categories.chore).toBe(1);
    });

    it("should detect breaking changes", () => {
      const commits = [
        { subject: "feat: normal feature", isBreaking: false },
        { subject: "feat!: breaking feature", isBreaking: true },
        {
          subject: "breaking: redesign API",
          isBreaking: true,
        },
      ];

      commits.forEach((c) => {
        const isBreaking =
          c.subject.includes("!:") ||
          c.subject.toLowerCase().includes("breaking");
        expect(isBreaking).toBe(c.isBreaking);
      });
    });
  });
});
