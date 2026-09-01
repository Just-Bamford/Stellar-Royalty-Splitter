import { jest, describe, test, expect, beforeEach } from "@jest/globals";

const mockGetSubscribersDue = jest.fn();
const mockGetEarningsForWeek = jest.fn();
const mockWasDigestSentThisWeek = jest.fn();
const mockLogDigestSent = jest.fn();
const mockLogDigestFailed = jest.fn();

await jest.unstable_mockModule("../src/database/email-digest.js", () => ({
  getSubscribersDueForDigest: mockGetSubscribersDue,
  getEarningsForWeek: mockGetEarningsForWeek,
  wasDigestSentThisWeek: mockWasDigestSentThisWeek,
  logDigestSent: mockLogDigestSent,
  logDigestFailed: mockLogDigestFailed,
}));

await jest.unstable_mockModule("../src/email/email-service.js", () => ({
  isEmailConfigured: jest.fn(() => true),
  sendEmail: jest.fn(() => Promise.resolve({ sent: true, messageId: "test-123" })),
}));

await jest.unstable_mockModule("../src/database/index.js", () => ({
  initializeDatabase: jest.fn(),
  getMigrationVersion: jest.fn(() => 6),
}));

const { sendWeeklyDigests } = await import("../src/jobs/weekly-digest-job.js");
const { sendEmail } = await import("../src/email/email-service.js");

describe("Weekly digest job (#569)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.BASE_URL = "https://example.com";
  });

  test("returns zero counts when no subscribers are due", async () => {
    mockGetSubscribersDue.mockReturnValue([]);

    const result = await sendWeeklyDigests();

    expect(result.sent).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  test("skips subscriber if digest already sent this week", async () => {
    mockGetSubscribersDue.mockReturnValue([
      { id: 1, walletAddress: "GWALLET1", email: "a@test.com", unsubscribeToken: "tok1" },
    ]);
    mockWasDigestSentThisWeek.mockReturnValue(true);

    const result = await sendWeeklyDigests();

    expect(result.skipped).toBe(1);
    expect(result.sent).toBe(0);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  test("skips subscriber with zero earnings", async () => {
    mockGetSubscribersDue.mockReturnValue([
      { id: 1, walletAddress: "GWALLET1", email: "a@test.com", unsubscribeToken: "tok1" },
    ]);
    mockWasDigestSentThisWeek.mockReturnValue(false);
    mockGetEarningsForWeek.mockReturnValue({
      totalEarned: 0,
      payoutCount: 0,
      contracts: [],
      topContract: null,
    });

    const result = await sendWeeklyDigests();

    expect(result.skipped).toBe(1);
    expect(result.sent).toBe(0);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  test("sends digest when there are earnings", async () => {
    const subscriber = {
      id: 1,
      walletAddress: "GWALLET1",
      email: "a@test.com",
      unsubscribeToken: "tok1",
    };
    mockGetSubscribersDue.mockReturnValue([subscriber]);
    mockWasDigestSentThisWeek.mockReturnValue(false);
    mockGetEarningsForWeek.mockReturnValue({
      totalEarned: 5.5,
      payoutCount: 3,
      contracts: [{ contractId: "C1", totalEarned: 5.5, payoutCount: 3 }],
      topContract: { contractId: "C1", totalEarned: 5.5, payoutCount: 3 },
    });

    const result = await sendWeeklyDigests();

    expect(result.sent).toBe(1);
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "a@test.com",
        subject: expect.stringContaining("Weekly Earnings Summary"),
      }),
    );
    expect(mockLogDigestSent).toHaveBeenCalledWith(1, expect.any(String), expect.any(String), expect.any(Object));
  });

  test("handles send failure gracefully", async () => {
    const { sendEmail: realSendEmail } = await import("../src/email/email-service.js");
    realSendEmail.mockResolvedValueOnce({ sent: false, reason: "connection_refused" });

    mockGetSubscribersDue.mockReturnValue([
      { id: 2, walletAddress: "GWALLET2", email: "b@test.com", unsubscribeToken: "tok2" },
    ]);
    mockWasDigestSentThisWeek.mockReturnValue(false);
    mockGetEarningsForWeek.mockReturnValue({
      totalEarned: 1.0,
      payoutCount: 1,
      contracts: [{ contractId: "C1", totalEarned: 1.0, payoutCount: 1 }],
      topContract: { contractId: "C1", totalEarned: 1.0, payoutCount: 1 },
    });

    const result = await sendWeeklyDigests();

    expect(result.failed).toBe(1);
    expect(result.sent).toBe(0);
    expect(mockLogDigestFailed).toHaveBeenCalled();
  });

  test("processes multiple subscribers", async () => {
    mockGetSubscribersDue.mockReturnValue([
      { id: 1, walletAddress: "GWALLET1", email: "a@test.com", unsubscribeToken: "tok1" },
      { id: 2, walletAddress: "GWALLET2", email: "b@test.com", unsubscribeToken: "tok2" },
      { id: 3, walletAddress: "GWALLET3", email: "c@test.com", unsubscribeToken: "tok3" },
    ]);
    mockWasDigestSentThisWeek.mockReturnValue(false);
    mockGetEarningsForWeek.mockReturnValue({
      totalEarned: 2.0,
      payoutCount: 1,
      contracts: [{ contractId: "C1", totalEarned: 2.0, payoutCount: 1 }],
      topContract: { contractId: "C1", totalEarned: 2.0, payoutCount: 1 },
    });

    const result = await sendWeeklyDigests();

    expect(result.sent).toBe(3);
    expect(sendEmail).toHaveBeenCalledTimes(3);
  });

  test("returns disabled when SMTP not configured", async () => {
    const { isEmailConfigured } = await import("../src/email/email-service.js");
    isEmailConfigured.mockReturnValueOnce(false);

    const result = await sendWeeklyDigests();

    expect(result.reason).toBe("smtp_not_configured");
  });
});
