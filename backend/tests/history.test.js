import { jest, describe, test, expect, beforeEach } from "@jest/globals";

const emitWebhookEvent = jest.fn();

await jest.unstable_mockModule("../src/services/webhook-manager.js", () => ({
  emitWebhookEvent,
}));

const { emitSecondaryDistributionCompleted } = await import("../src/routes/history.js");

describe("emitSecondaryDistributionCompleted (#1188)", () => {
  beforeEach(() => jest.clearAllMocks());

  test("uses transaction.saleToken as the webhook's tokenId for a secondary royalty distribution", async () => {
    await emitSecondaryDistributionCompleted({
      contractId: "CCONTRACT",
      txHash: "TXHASH123",
      saleToken: "SALE_TOKEN_ABC",
      tokenId: undefined,
      requestedAmount: "100",
      status: "completed",
      blockTime: 1700000000,
    });

    expect(emitWebhookEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        contractId: "CCONTRACT",
        event: "distribution.completed",
        data: expect.objectContaining({
          tokenId: "SALE_TOKEN_ABC",
          kind: "secondary",
        }),
      })
    );
  });

  test("prefers saleToken over tokenId even when both are present", async () => {
    await emitSecondaryDistributionCompleted({
      contractId: "CCONTRACT",
      txHash: "TXHASH456",
      saleToken: "SALE_TOKEN_NEW",
      tokenId: "LEGACY_TOKEN_ID",
      requestedAmount: "50",
      status: "completed",
    });

    expect(emitWebhookEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ tokenId: "SALE_TOKEN_NEW" }),
      })
    );
  });

  test("falls back to tokenId when saleToken is absent (backwards compatibility)", async () => {
    await emitSecondaryDistributionCompleted({
      contractId: "CCONTRACT",
      txHash: "TXHASH789",
      saleToken: undefined,
      tokenId: "LEGACY_TOKEN_ID",
      requestedAmount: "25",
      status: "completed",
    });

    expect(emitWebhookEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ tokenId: "LEGACY_TOKEN_ID" }),
      })
    );
  });

  test("tokenId is null when neither saleToken nor tokenId is set", async () => {
    await emitSecondaryDistributionCompleted({
      contractId: "CCONTRACT",
      txHash: "TXHASHNONE",
      requestedAmount: "10",
      status: "completed",
    });

    expect(emitWebhookEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ tokenId: undefined }),
      })
    );
  });
});
