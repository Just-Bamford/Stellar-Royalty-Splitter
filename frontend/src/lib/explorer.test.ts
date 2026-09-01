import { describe, test, expect } from "vitest";
import { getStellarExpertTxUrl, formatTxHash } from "./explorer";

/**
 * Tests for explorer URL helpers (#299, #686).
 *
 * Covers:
 *  - Correct URL for testnet (maps to "testnet" segment)
 *  - Correct URL for mainnet (maps to "public" segment)
 *  - Short hash is returned as-is (no truncation below threshold)
 *  - Long hash is truncated for display
 *  - Custom head/tail lengths for formatTxHash
 */
describe("explorer helpers (#299, #686)", () => {
  const FULL_HASH = "a".repeat(64);
  const SHORT_HASH = "abc123";

  // -----------------------------------------------------------------------
  // Network-aware URL generation
  // -----------------------------------------------------------------------

  test("builds testnet Stellar Expert URL", () => {
    expect(getStellarExpertTxUrl("testnet", FULL_HASH)).toBe(
      `https://stellar.expert/explorer/testnet/tx/${FULL_HASH}`,
    );
  });

  test("builds mainnet Stellar Expert URL (uses 'public' segment)", () => {
    expect(getStellarExpertTxUrl("mainnet", FULL_HASH)).toBe(
      `https://stellar.expert/explorer/public/tx/${FULL_HASH}`,
    );
  });

  test("testnet and mainnet URLs differ only in the network segment", () => {
    const testnetUrl = getStellarExpertTxUrl("testnet", FULL_HASH);
    const mainnetUrl = getStellarExpertTxUrl("mainnet", FULL_HASH);
    expect(testnetUrl).not.toBe(mainnetUrl);
    expect(testnetUrl).toContain("/testnet/");
    expect(mainnetUrl).toContain("/public/");
  });

  test("URL always contains the full transaction hash", () => {
    const url = getStellarExpertTxUrl("testnet", FULL_HASH);
    expect(url).toContain(FULL_HASH);
  });

  test("URL is a valid absolute HTTPS URL", () => {
    const url = getStellarExpertTxUrl("testnet", FULL_HASH);
    expect(() => new URL(url)).not.toThrow();
    expect(new URL(url).protocol).toBe("https:");
  });

  // -----------------------------------------------------------------------
  // formatTxHash — truncation for display
  // -----------------------------------------------------------------------

  test("truncates a 64-char hash for display", () => {
    expect(formatTxHash(FULL_HASH)).toBe(`${"a".repeat(8)}…${"a".repeat(8)}`);
  });

  test("short hash (≤ head+tail+3) is returned unchanged", () => {
    // Default head=8, tail=8 → threshold = 8+8+3 = 19 chars
    expect(formatTxHash(SHORT_HASH)).toBe(SHORT_HASH);
    expect(formatTxHash("x".repeat(19))).toBe("x".repeat(19));
  });

  test("hash exactly one char over threshold is truncated", () => {
    const borderHash = "x".repeat(20); // 20 > 19 → truncated
    expect(formatTxHash(borderHash)).toBe(`${"x".repeat(8)}…${"x".repeat(8)}`);
  });

  test("custom head and tail lengths are respected", () => {
    const hash = "abcdef0123456789abcdef";
    expect(formatTxHash(hash, 4, 4)).toBe("abcd…cdef");
  });

  // -----------------------------------------------------------------------
  // Fallback: undefined / null hash handled by the caller (no crash)
  // -----------------------------------------------------------------------

  test("formatTxHash handles an empty string without throwing", () => {
    expect(() => formatTxHash("")).not.toThrow();
    expect(formatTxHash("")).toBe("");
  });
});
