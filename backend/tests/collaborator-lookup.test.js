import { jest, describe, test, expect, beforeEach } from "@jest/globals";

const COLLAB1 = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const COLLAB2 = "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";

const auditRows = [];
const payoutRows = [];

await jest.unstable_mockModule("../src/database/core.js", () => ({
  db: {
    prepare: jest.fn((sql) => ({
      all: jest.fn(() => (sql.includes("audit_log") ? auditRows : payoutRows)),
    })),
  },
}));

const { lookupCollaborators } = await import("../src/database/collaborator-lookup.js");

describe("lookupCollaborators", () => {
  beforeEach(() => {
    auditRows.length = 0;
    payoutRows.length = 0;
  });

  test("returns no suggestions when there is no history", () => {
    expect(lookupCollaborators()).toEqual([]);
  });

  test("returns collaborators from initialize history", () => {
    auditRows.push({
      contractId: "CAAA",
      timestamp: "2026-01-01T00:00:00.000Z",
      details: JSON.stringify({ collaborators: [COLLAB1] }),
    });

    expect(lookupCollaborators()).toEqual([
      expect.objectContaining({
        address: COLLAB1,
        contractId: "CAAA",
        sources: ["initialize_history"],
      }),
    ]);
  });

  test("filters suggestions by partial address query", () => {
    auditRows.push({
      contractId: "CAAA",
      timestamp: "2026-01-01T00:00:00.000Z",
      details: JSON.stringify({ collaborators: [COLLAB1, COLLAB2] }),
    });

    const suggestions = lookupCollaborators("CCCC");

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].address).toBe(COLLAB2);
  });

  test("deduplicates addresses across initialize and payout history", () => {
    auditRows.push({
      contractId: "CAAA",
      timestamp: "2026-01-01T00:00:00.000Z",
      details: JSON.stringify({ collaborators: [COLLAB1] }),
    });
    payoutRows.push({
      contractId: "CBBB",
      address: COLLAB1,
      timestamp: "2026-01-02T00:00:00.000Z",
    });

    const suggestions = lookupCollaborators();

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].sources).toEqual(["initialize_history", "payout_history"]);
    expect(suggestions[0].lastSeen).toBe("2026-01-02T00:00:00.000Z");
  });
});
