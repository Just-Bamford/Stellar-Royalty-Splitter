import { describe, test, expect } from "@jest/globals";
import { getStellarExpertTxUrl, formatTxHash } from "../src/lib/explorer";

describe("explorer helpers (#299)", () => {
  const hash = "a".repeat(64);

  test("builds testnet Stellar Expert URL", () => {
    expect(getStellarExpertTxUrl("testnet", hash)).toBe(
      `https://stellar.expert/explorer/testnet/tx/${hash}`,
    );
  });

  test("builds mainnet Stellar Expert URL", () => {
    expect(getStellarExpertTxUrl("mainnet", hash)).toBe(
      `https://stellar.expert/explorer/public/tx/${hash}`,
    );
  });

  test("truncates long hashes for display", () => {
    expect(formatTxHash(hash)).toBe(`${"a".repeat(8)}…${"a".repeat(8)}`);
  });
});
