import { jest, describe, test, expect, beforeEach } from "@jest/globals";
import request from "supertest";
import express from "express";

const mockGetTwoFactorStatus = jest.fn();
const mockBeginTwoFactorSetup = jest.fn();
const mockConfirmTwoFactorSetup = jest.fn();
const mockDecryptTwoFactorSecret = jest.fn();
const mockConsumeBackupCode = jest.fn();
const mockDisableTwoFactor = jest.fn();
const mockCreateVerifiedSession = jest.fn();
const mockIsSessionValid = jest.fn();
const mockRevokeSessions = jest.fn();

await jest.unstable_mockModule("../src/database/two-factor.js", () => ({
  getTwoFactorStatus: mockGetTwoFactorStatus,
  beginTwoFactorSetup: mockBeginTwoFactorSetup,
  confirmTwoFactorSetup: mockConfirmTwoFactorSetup,
  decryptTwoFactorSecret: mockDecryptTwoFactorSecret,
  consumeBackupCode: mockConsumeBackupCode,
  disableTwoFactor: mockDisableTwoFactor,
  createVerifiedSession: mockCreateVerifiedSession,
  isSessionValid: mockIsSessionValid,
  revokeSessions: mockRevokeSessions,
}));

const mockGenerateTotpSecret = jest.fn(() => "JBSWY3DPEHPK3PXP");
const mockGenerateBackupCodes = jest.fn(() => ["AAAAA-BBBBB", "CCCCC-DDDDD"]);
const mockBuildOtpAuthUri = jest.fn(() => "otpauth://totp/Stellar:test");
const mockVerifyTotp = jest.fn();
const mockIsExpiredTotp = jest.fn();

await jest.unstable_mockModule("../src/services/totp.js", () => ({
  generateTotpSecret: mockGenerateTotpSecret,
  generateBackupCodes: mockGenerateBackupCodes,
  buildOtpAuthUri: mockBuildOtpAuthUri,
  verifyTotp: mockVerifyTotp,
  isExpiredTotp: mockIsExpiredTotp,
}));

const { authRouter } = await import("../src/routes/auth.js");

const app = express();
app.use(express.json());
app.use("/api/v1/auth", authRouter);

const WALLET = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

describe("Auth 2FA API", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCreateVerifiedSession.mockReturnValue({
      token: "session-token",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    mockBeginTwoFactorSetup.mockReturnValue({ userId: 1 });
    mockGetTwoFactorStatus.mockReturnValue({
      walletAddress: WALLET,
      role: "admin",
      enabled: false,
      pending: false,
      verifiedSessionRequired: false,
    });
    mockIsSessionValid.mockReturnValue(false);
  });

  test("setup returns QR otpauth URL and backup codes", async () => {
    const res = await request(app)
      .post("/api/v1/auth/2fa/setup")
      .send({ walletAddress: WALLET });

    expect(res.status).toBe(201);
    expect(res.body.data.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
    expect(res.body.data.secret).toBeTruthy();
    expect(res.body.data.backupCodes).toHaveLength(2);
    expect(mockBeginTwoFactorSetup).toHaveBeenCalled();
  });

  test("confirm enables 2FA with a valid TOTP", async () => {
    mockDecryptTwoFactorSecret.mockReturnValue("JBSWY3DPEHPK3PXP");
    mockVerifyTotp.mockReturnValue(true);

    const confirm = await request(app)
      .post("/api/v1/auth/2fa/confirm")
      .send({ walletAddress: WALLET, code: "123456" });

    expect(confirm.status).toBe(200);
    expect(confirm.body.data.enabled).toBe(true);
    expect(confirm.body.data.sessionToken).toBe("session-token");
    expect(mockConfirmTwoFactorSetup).toHaveBeenCalledWith(WALLET);
  });

  test("verify accepts valid code and rejects invalid/expired codes", async () => {
    mockGetTwoFactorStatus.mockReturnValue({
      walletAddress: WALLET,
      role: "admin",
      enabled: true,
      pending: false,
      verifiedSessionRequired: true,
    });
    mockDecryptTwoFactorSecret.mockReturnValue("JBSWY3DPEHPK3PXP");

    mockIsExpiredTotp.mockReturnValue(false);
    mockVerifyTotp.mockReturnValue(true);
    const valid = await request(app)
      .post("/api/v1/auth/2fa/verify")
      .send({ walletAddress: WALLET, code: "123456" });
    expect(valid.status).toBe(200);
    expect(valid.body.data.verified).toBe(true);

    mockVerifyTotp.mockReturnValue(false);
    mockIsExpiredTotp.mockReturnValue(false);
    const invalid = await request(app)
      .post("/api/v1/auth/2fa/verify")
      .send({ walletAddress: WALLET, code: "000000" });
    expect(invalid.status).toBe(401);
    expect(invalid.body.code).toBe("invalid_totp");

    mockIsExpiredTotp.mockReturnValue(true);
    const expired = await request(app)
      .post("/api/v1/auth/2fa/verify")
      .send({ walletAddress: WALLET, code: "999999" });
    expect(expired.status).toBe(401);
    expect(expired.body.code).toBe("expired_totp");
  });

  test("recovery flow works with a one-time backup code", async () => {
    mockGetTwoFactorStatus.mockReturnValue({
      walletAddress: WALLET,
      role: "admin",
      enabled: true,
      pending: false,
      verifiedSessionRequired: true,
    });
    mockConsumeBackupCode.mockReturnValueOnce(true).mockReturnValueOnce(false);

    const recover = await request(app)
      .post("/api/v1/auth/2fa/recover")
      .send({ walletAddress: WALLET, backupCode: "AAAAA-BBBBB" });
    expect(recover.status).toBe(200);
    expect(recover.body.data.recovered).toBe(true);

    const reuse = await request(app)
      .post("/api/v1/auth/2fa/recover")
      .send({ walletAddress: WALLET, backupCode: "AAAAA-BBBBB" });
    expect(reuse.status).toBe(401);
  });

  test("admins can disable 2FA with a valid TOTP", async () => {
    mockGetTwoFactorStatus.mockReturnValue({
      walletAddress: WALLET,
      role: "admin",
      enabled: true,
      pending: false,
      verifiedSessionRequired: true,
    });
    mockDecryptTwoFactorSecret.mockReturnValue("JBSWY3DPEHPK3PXP");
    mockVerifyTotp.mockReturnValue(true);

    const disable = await request(app)
      .post("/api/v1/auth/2fa/disable")
      .send({ walletAddress: WALLET, code: "123456" });

    expect(disable.status).toBe(200);
    expect(disable.body.data.enabled).toBe(false);
    expect(mockDisableTwoFactor).toHaveBeenCalledWith(WALLET);
  });
});
