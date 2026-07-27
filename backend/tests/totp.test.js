import { describe, test, expect } from "@jest/globals";
import {
  generateTotp,
  generateTotpSecret,
  verifyTotp,
  isExpiredTotp,
  generateBackupCodes,
  hashBackupCode,
  buildOtpAuthUri,
} from "../src/services/totp.js";

describe("TOTP service", () => {
  test("accepts a valid 6-digit code", () => {
    const secret = generateTotpSecret();
    const now = Date.now();
    const code = generateTotp(secret, now);
    expect(code).toMatch(/^\d{6}$/);
    expect(verifyTotp({ secret, token: code, atMs: now })).toBe(true);
  });

  test("rejects an invalid code", () => {
    const secret = generateTotpSecret();
    expect(verifyTotp({ secret, token: "000000", atMs: Date.now() })).toBe(false);
  });

  test("detects an expired code from a prior step", () => {
    const secret = generateTotpSecret();
    const now = Date.now();
    const stale = generateTotp(secret, now - 2 * 30_000);
    expect(isExpiredTotp({ secret, token: stale, atMs: now, staleSteps: 2 })).toBe(true);
    expect(verifyTotp({ secret, token: stale, atMs: now, window: 1 })).toBe(false);
  });

  test("builds otpauth URIs for authenticator apps", () => {
    const uri = buildOtpAuthUri({
      secret: "JBSWY3DPEHPK3PXP",
      accountName: "admin@example",
    });
    expect(uri).toMatch(/^otpauth:\/\/totp\//);
    expect(uri).toContain("secret=JBSWY3DPEHPK3PXP");
  });

  test("hashes backup codes consistently", () => {
    const codes = generateBackupCodes(2);
    expect(codes).toHaveLength(2);
    expect(hashBackupCode(codes[0])).toBe(hashBackupCode(codes[0].toLowerCase()));
    expect(hashBackupCode(codes[0])).not.toBe(hashBackupCode(codes[1]));
  });
});
