/**
 * Tests for the Stripe service wrapper — closes #924.
 *
 * The `stripe` npm package is mocked so these tests never make a real
 * network call. Mirrors the mocking approach used by
 * `tests/twilio-sms.test.js` (#927) for the equivalent Twilio wrapper.
 */
import { jest, describe, test, expect, beforeEach, afterEach } from "@jest/globals";

const mockOAuthToken = jest.fn();
const mockPayoutsCreate = jest.fn();
const mockPayoutsRetrieve = jest.fn();
const mockConstructEvent = jest.fn();

const MockStripeConstructor = jest.fn().mockImplementation(() => ({
  oauth: { token: mockOAuthToken },
  payouts: { create: mockPayoutsCreate, retrieve: mockPayoutsRetrieve },
  webhooks: { constructEvent: mockConstructEvent },
}));

jest.unstable_mockModule("stripe", () => ({
  default: MockStripeConstructor,
}));

const {
  isStripeConfigured,
  resetStripeClientCache,
  buildConnectOAuthUrl,
  createConnectState,
  verifyConnectState,
  exchangeConnectCode,
  createStripePayout,
  getStripePayoutStatus,
  verifyStripeWebhookSignature,
  DEFAULT_STRIPE_CONNECT_OAUTH_URL,
} = await import("../src/services/stripe.js");

const WALLET = "GA7E6YDRQKJ2JNOG27UPSCQ3FQ6U4X3QQGJKHNGF23T7QCI2FM6E3W2P";

describe("Stripe service wrapper (#924)", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    resetStripeClientCache();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
    resetStripeClientCache();
  });

  describe("isStripeConfigured", () => {
    test("returns false when STRIPE_SECRET_KEY is unset", () => {
      delete process.env.STRIPE_SECRET_KEY;
      expect(isStripeConfigured()).toBe(false);
    });

    test("returns true when STRIPE_SECRET_KEY is set", () => {
      process.env.STRIPE_SECRET_KEY = "sk_test_123";
      expect(isStripeConfigured()).toBe(true);
    });
  });

  describe("Connect OAuth state", () => {
    beforeEach(() => {
      process.env.STRIPE_SECRET_KEY = "sk_test_123";
    });

    test("createConnectState fails when Stripe is not configured", () => {
      delete process.env.STRIPE_SECRET_KEY;
      const result = createConnectState(WALLET);
      expect(result).toEqual({ ok: false, reason: "stripe_not_configured" });
    });

    test("round-trips: a freshly created state verifies to the same wallet", () => {
      const created = createConnectState(WALLET);
      expect(created.ok).toBe(true);

      const verified = verifyConnectState(created.state);
      expect(verified).toEqual({ walletAddress: WALLET });
    });

    test("rejects a tampered state", () => {
      const created = createConnectState(WALLET);
      const tampered = created.state.slice(0, -2) + "xx";
      expect(verifyConnectState(tampered)).toBeNull();
    });

    test("rejects an expired state", () => {
      const created = createConnectState(WALLET, { ttlMs: -1000 });
      expect(verifyConnectState(created.state)).toBeNull();
    });

    test("rejects a state signed under a different secret", () => {
      const created = createConnectState(WALLET);
      process.env.STRIPE_SECRET_KEY = "sk_test_a-different-key";
      expect(verifyConnectState(created.state)).toBeNull();
    });

    test("verifyConnectState returns null when Stripe is not configured", () => {
      const created = createConnectState(WALLET);
      delete process.env.STRIPE_SECRET_KEY;
      expect(verifyConnectState(created.state)).toBeNull();
    });
  });

  describe("buildConnectOAuthUrl", () => {
    beforeEach(() => {
      process.env.STRIPE_SECRET_KEY = "sk_test_123";
      process.env.STRIPE_CONNECT_CLIENT_ID = "ca_test_123";
    });

    test("returns a well-formed authorize URL with a signed state", () => {
      const result = buildConnectOAuthUrl({
        walletAddress: WALLET,
        redirectUri: "https://app.example.com/stripe/callback",
      });

      expect(result.ok).toBe(true);
      expect(result.url.startsWith(DEFAULT_STRIPE_CONNECT_OAUTH_URL)).toBe(true);
      const parsed = new URL(result.url);
      expect(parsed.searchParams.get("client_id")).toBe("ca_test_123");
      expect(parsed.searchParams.get("redirect_uri")).toBe("https://app.example.com/stripe/callback");
      expect(parsed.searchParams.get("state")).toBe(result.state);
      expect(verifyConnectState(result.state)).toEqual({ walletAddress: WALLET });
    });

    test("fails when STRIPE_CONNECT_CLIENT_ID is not configured", () => {
      delete process.env.STRIPE_CONNECT_CLIENT_ID;
      const result = buildConnectOAuthUrl({
        walletAddress: WALLET,
        redirectUri: "https://app.example.com/stripe/callback",
      });
      expect(result).toEqual({ ok: false, reason: "stripe_connect_not_configured" });
    });

    test("fails when walletAddress is missing", () => {
      const result = buildConnectOAuthUrl({ redirectUri: "https://app.example.com/stripe/callback" });
      expect(result).toEqual({ ok: false, reason: "missing_wallet_address" });
    });

    test("fails when redirectUri is missing", () => {
      const result = buildConnectOAuthUrl({ walletAddress: WALLET });
      expect(result).toEqual({ ok: false, reason: "missing_redirect_uri" });
    });
  });

  describe("exchangeConnectCode", () => {
    test("fails when Stripe is not configured", async () => {
      delete process.env.STRIPE_SECRET_KEY;
      const result = await exchangeConnectCode("auth-code");
      expect(result).toEqual({ ok: false, reason: "stripe_not_configured" });
    });

    test("fails when code is missing", async () => {
      process.env.STRIPE_SECRET_KEY = "sk_test_123";
      const result = await exchangeConnectCode();
      expect(result).toEqual({ ok: false, reason: "missing_code" });
    });

    test("resolves the connected account id on success", async () => {
      process.env.STRIPE_SECRET_KEY = "sk_test_123";
      mockOAuthToken.mockResolvedValue({ stripe_user_id: "acct_ABC123" });

      const result = await exchangeConnectCode("auth-code");

      expect(result).toEqual({ ok: true, stripeAccountId: "acct_ABC123" });
      expect(mockOAuthToken).toHaveBeenCalledWith({ grant_type: "authorization_code", code: "auth-code" });
    });

    test("never throws — resolves a typed failure when Stripe rejects the code", async () => {
      process.env.STRIPE_SECRET_KEY = "sk_test_123";
      mockOAuthToken.mockRejectedValue(new Error("invalid_grant"));

      const result = await exchangeConnectCode("bad-code");

      expect(result).toEqual({ ok: false, reason: "invalid_grant" });
    });

    test("fails when Stripe's response is missing stripe_user_id", async () => {
      process.env.STRIPE_SECRET_KEY = "sk_test_123";
      mockOAuthToken.mockResolvedValue({});

      const result = await exchangeConnectCode("auth-code");

      expect(result).toEqual({ ok: false, reason: "missing_stripe_user_id" });
    });
  });

  describe("createStripePayout", () => {
    beforeEach(() => {
      process.env.STRIPE_SECRET_KEY = "sk_test_123";
    });

    test("fails when Stripe is not configured", async () => {
      delete process.env.STRIPE_SECRET_KEY;
      const result = await createStripePayout({ stripeAccountId: "acct_1", amountUsdCents: 500 });
      expect(result).toEqual({ ok: false, reason: "stripe_not_configured" });
    });

    test("fails when stripeAccountId is missing", async () => {
      const result = await createStripePayout({ amountUsdCents: 500 });
      expect(result).toEqual({ ok: false, reason: "missing_stripe_account_id" });
      expect(mockPayoutsCreate).not.toHaveBeenCalled();
    });

    test.each([0, -100, 1.5, NaN])("rejects a non-positive-integer amount (%p)", async (amount) => {
      const result = await createStripePayout({ stripeAccountId: "acct_1", amountUsdCents: amount });
      expect(result).toEqual({ ok: false, reason: "invalid_amount" });
      expect(mockPayoutsCreate).not.toHaveBeenCalled();
    });

    test("creates a payout with the exact converted amount — the issue's named E2E scenario", async () => {
      mockPayoutsCreate.mockResolvedValue({ id: "po_123", status: "pending" });

      const result = await createStripePayout({
        stripeAccountId: "acct_1",
        amountUsdCents: 12345,
        idempotencyKey: "payout-7",
      });

      expect(result).toEqual({ ok: true, stripePayoutId: "po_123", status: "pending" });
      expect(mockPayoutsCreate).toHaveBeenCalledWith(
        { amount: 12345, currency: "usd" },
        { stripeAccount: "acct_1", idempotencyKey: "payout-7" }
      );
    });

    test("never throws — resolves a typed failure when the Stripe API call fails", async () => {
      mockPayoutsCreate.mockRejectedValue(new Error("insufficient_funds"));

      const result = await createStripePayout({ stripeAccountId: "acct_1", amountUsdCents: 500 });

      expect(result).toEqual({ ok: false, reason: "insufficient_funds" });
    });

    test("surfaces a Stripe raw.message when present", async () => {
      const error = new Error("generic");
      error.raw = { message: "Your card was declined." };
      mockPayoutsCreate.mockRejectedValue(error);

      const result = await createStripePayout({ stripeAccountId: "acct_1", amountUsdCents: 500 });

      expect(result).toEqual({ ok: false, reason: "Your card was declined." });
    });
  });

  describe("getStripePayoutStatus", () => {
    beforeEach(() => {
      process.env.STRIPE_SECRET_KEY = "sk_test_123";
    });

    test("fails when identifiers are missing", async () => {
      const result = await getStripePayoutStatus({ stripeAccountId: "acct_1" });
      expect(result).toEqual({ ok: false, reason: "missing_identifiers" });
    });

    test("returns the current Stripe status", async () => {
      mockPayoutsRetrieve.mockResolvedValue({ id: "po_123", status: "in_transit" });

      const result = await getStripePayoutStatus({ stripeAccountId: "acct_1", stripePayoutId: "po_123" });

      expect(result).toEqual({ ok: true, status: "in_transit" });
      expect(mockPayoutsRetrieve).toHaveBeenCalledWith("po_123", { stripeAccount: "acct_1" });
    });

    test("never throws — resolves a typed failure on a lookup error", async () => {
      mockPayoutsRetrieve.mockRejectedValue(new Error("no_such_payout"));
      const result = await getStripePayoutStatus({ stripeAccountId: "acct_1", stripePayoutId: "po_bad" });
      expect(result).toEqual({ ok: false, reason: "no_such_payout" });
    });
  });

  describe("verifyStripeWebhookSignature", () => {
    beforeEach(() => {
      process.env.STRIPE_SECRET_KEY = "sk_test_123";
      process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_123";
    });

    test("fails when STRIPE_WEBHOOK_SECRET is not configured", () => {
      delete process.env.STRIPE_WEBHOOK_SECRET;
      const result = verifyStripeWebhookSignature({ rawBody: "{}", signature: "t=1,v1=abc" });
      expect(result).toEqual({ ok: false, reason: "stripe_webhook_not_configured" });
    });

    test("fails when the signature header is missing", () => {
      const result = verifyStripeWebhookSignature({ rawBody: "{}" });
      expect(result).toEqual({ ok: false, reason: "missing_signature" });
    });

    test("returns the parsed event on a valid signature", () => {
      const event = { id: "evt_123", type: "payout.paid" };
      mockConstructEvent.mockReturnValue(event);

      const result = verifyStripeWebhookSignature({ rawBody: "{}", signature: "t=1,v1=abc" });

      expect(result).toEqual({ ok: true, event });
    });

    test("never throws — resolves a typed failure on an invalid signature", () => {
      mockConstructEvent.mockImplementation(() => {
        throw new Error("No signatures found matching the expected signature for payload");
      });

      const result = verifyStripeWebhookSignature({ rawBody: "{}", signature: "t=1,v1=bad" });

      expect(result).toEqual({ ok: false, reason: "invalid_signature" });
    });
  });
});
