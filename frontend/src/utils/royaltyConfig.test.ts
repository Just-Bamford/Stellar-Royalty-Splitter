/**
 * Tests for royalty split configuration versioning (#679).
 */

import { describe, test, expect } from "vitest";
import {
  ROYALTY_CONFIG_VERSION,
  SUPPORTED_CONFIG_VERSIONS,
  parseRoyaltyConfigImport,
  buildRoyaltyConfigExport,
  RoyaltyConfigImportError,
  RoyaltyConfigExportError,
} from "./royaltyConfig";

const ADDR_A = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA";
const ADDR_B = "GBCG42WTVWPO4Q6OZCYI3ZIDFAW2RNNAJFBFMDKOBQM7SQKTFNTKLTIA";

function validConfig(version: number | unknown = 1) {
  return JSON.stringify({
    version,
    createdAt: new Date().toISOString(),
    collaborators: [
      { address: ADDR_A, percentage: 60 },
      { address: ADDR_B, percentage: 40 },
    ],
  });
}

describe("ROYALTY_CONFIG_VERSION / SUPPORTED_CONFIG_VERSIONS (#679)", () => {
  test("current version is 1", () => {
    expect(ROYALTY_CONFIG_VERSION).toBe(1);
  });

  test("version 1 is in the supported list", () => {
    expect(SUPPORTED_CONFIG_VERSIONS).toContain(1);
  });

  test("supported list contains only version 1 currently", () => {
    expect(SUPPORTED_CONFIG_VERSIONS).toHaveLength(1);
  });
});

describe("parseRoyaltyConfigImport — version validation (#679)", () => {
  test("accepts a file with version 1", () => {
    const result = parseRoyaltyConfigImport(validConfig(1));
    expect(result).toHaveLength(2);
    expect(result[0].address).toBe(ADDR_A);
  });

  test("throws when version field is missing", () => {
    const raw = JSON.stringify({
      collaborators: [{ address: ADDR_A, percentage: 100 }],
    });
    expect(() => parseRoyaltyConfigImport(raw)).toThrow(
      RoyaltyConfigImportError,
    );
    try {
      parseRoyaltyConfigImport(raw);
    } catch (e) {
      expect((e as RoyaltyConfigImportError).errors[0]).toContain(
        '"version" field is required',
      );
    }
  });

  test("throws when version is null", () => {
    const raw = JSON.stringify({
      version: null,
      collaborators: [{ address: ADDR_A, percentage: 100 }],
    });
    expect(() => parseRoyaltyConfigImport(raw)).toThrow(
      RoyaltyConfigImportError,
    );
  });

  test("throws when version is a string instead of number", () => {
    expect(() => parseRoyaltyConfigImport(validConfig("1"))).toThrow(
      RoyaltyConfigImportError,
    );
    try {
      parseRoyaltyConfigImport(validConfig("1"));
    } catch (e) {
      expect((e as RoyaltyConfigImportError).errors[0]).toContain(
        '"version" must be an integer',
      );
    }
  });

  test("throws when version is a float", () => {
    expect(() => parseRoyaltyConfigImport(validConfig(1.5))).toThrow(
      RoyaltyConfigImportError,
    );
  });

  test("throws a clear error for unsupported version 2", () => {
    expect(() => parseRoyaltyConfigImport(validConfig(2))).toThrow(
      RoyaltyConfigImportError,
    );
    try {
      parseRoyaltyConfigImport(validConfig(2));
    } catch (e) {
      expect((e as RoyaltyConfigImportError).errors[0]).toContain(
        "Unsupported configuration version 2",
      );
      expect((e as RoyaltyConfigImportError).errors[0]).toContain(
        "Supported versions: 1",
      );
    }
  });

  test("throws a clear error for unsupported version 0", () => {
    expect(() => parseRoyaltyConfigImport(validConfig(0))).toThrow(
      RoyaltyConfigImportError,
    );
  });

  test("throws a clear error for a large unsupported version", () => {
    try {
      parseRoyaltyConfigImport(validConfig(99));
    } catch (e) {
      expect((e as RoyaltyConfigImportError).errors[0]).toContain(
        "Unsupported configuration version 99",
      );
    }
  });
});

describe("parseRoyaltyConfigImport — existing validation still works (#679)", () => {
  test("throws when collaborators array is missing", () => {
    const raw = JSON.stringify({ version: 1 });
    expect(() => parseRoyaltyConfigImport(raw)).toThrow(
      RoyaltyConfigImportError,
    );
  });

  test("throws when percentages do not sum to 100", () => {
    const raw = JSON.stringify({
      version: 1,
      collaborators: [{ address: ADDR_A, percentage: 50 }],
    });
    expect(() => parseRoyaltyConfigImport(raw)).toThrow(
      RoyaltyConfigImportError,
    );
  });

  test("throws on duplicate address", () => {
    const raw = JSON.stringify({
      version: 1,
      collaborators: [
        { address: ADDR_A, percentage: 50 },
        { address: ADDR_A, percentage: 50 },
      ],
    });
    expect(() => parseRoyaltyConfigImport(raw)).toThrow(
      RoyaltyConfigImportError,
    );
  });
});

describe("buildRoyaltyConfigExport — version field (#679)", () => {
  test("export sets version to ROYALTY_CONFIG_VERSION", () => {
    const config = buildRoyaltyConfigExport(
      [
        { address: ADDR_A, basisPoints: "60" },
        { address: ADDR_B, basisPoints: "40" },
      ],
      new Date().toISOString(),
    );
    expect(config.version).toBe(ROYALTY_CONFIG_VERSION);
  });

  test("exported config can be re-imported successfully", () => {
    const config = buildRoyaltyConfigExport(
      [
        { address: ADDR_A, basisPoints: "70" },
        { address: ADDR_B, basisPoints: "30" },
      ],
      new Date().toISOString(),
    );
    const raw = JSON.stringify(config);
    const result = parseRoyaltyConfigImport(raw);
    expect(result).toHaveLength(2);
  });

  test("throws when collaborators list is empty", () => {
    expect(() =>
      buildRoyaltyConfigExport([], new Date().toISOString()),
    ).toThrow(RoyaltyConfigExportError);
  });
});
