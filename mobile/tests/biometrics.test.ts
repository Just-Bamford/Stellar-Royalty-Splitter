import { describe, it, expect, beforeEach } from "vitest";
import { biometricsService } from "../src/services/biometrics";

describe("Biometrics Service", () => {
  beforeEach(() => {
    biometricsService.setBiometryEnabled(true);
  });

  it("checks biometric hardware availability", async () => {
    const capability = await biometricsService.checkAvailability();
    expect(capability.available).toBe(true);
    expect(["FaceID", "TouchID", "Fingerprint"]).toContain(capability.biometryType);
  });

  it("authenticates successfully with biometric prompt", async () => {
    const result = await biometricsService.authenticate("Unlock app");
    expect(result.success).toBe(true);
  });

  it("stores and retrieves secure token in keychain/keystore", async () => {
    await biometricsService.setSecureItem("session_secret", "secret_jwt_token_12345");
    const retrieved = await biometricsService.getSecureItem("session_secret");
    expect(retrieved).toBe("secret_jwt_token_12345");

    await biometricsService.removeSecureItem("session_secret");
    const afterRemoval = await biometricsService.getSecureItem("session_secret");
    expect(afterRemoval).toBeNull();
  });

  it("respects biometry toggle", async () => {
    biometricsService.setBiometryEnabled(false);
    expect(biometricsService.isBiometryEnabled()).toBe(false);
    const result = await biometricsService.authenticate();
    expect(result.success).toBe(true);
  });
});
