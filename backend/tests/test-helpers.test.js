import {
  buildDistributePayload,
  buildInitializePayload,
  buildInitializePayloadWithCollaborators,
  buildSecondarySalePayload,
  runBatch,
  VALID_CONTRACT_ID,
  VALID_WALLET_A,
} from "./test-helpers.js";

describe("backend test helpers", () => {
  test("buildInitializePayload returns the default valid shape", () => {
    expect(buildInitializePayload()).toMatchObject({
      contractId: VALID_CONTRACT_ID,
      walletAddress: VALID_WALLET_A,
      shares: [5000, 5000],
    });
  });

  test("buildInitializePayloadWithCollaborators creates shares summing to 10000", () => {
    const payload = buildInitializePayloadWithCollaborators(3);
    expect(payload.collaborators).toHaveLength(3);
    expect(payload.shares.reduce((sum, share) => sum + share, 0)).toBe(10000);
  });

  test("buildDistributePayload supports overrides", () => {
    expect(buildDistributePayload({ tokenId: "COVERRIDE" }).tokenId).toBe("COVERRIDE");
  });

  test("buildSecondarySalePayload includes public API fields", () => {
    expect(buildSecondarySalePayload()).toMatchObject({
      nftId: "nft-1",
      salePrice: 1000,
      royaltyRate: 500,
    });
  });

  test("runBatch executes sequential scenario steps", async () => {
    const order = [];
    const results = await runBatch([
      async () => {
        order.push("initialize");
        return "tx-1";
      },
      async () => {
        order.push("distribute");
        return "tx-2";
      },
    ]);
    expect(order).toEqual(["initialize", "distribute"]);
    expect(results).toEqual(["tx-1", "tx-2"]);
  });
});
