import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  duplicateConfiguration,
  isValidDuplicateConfiguration,
  getDuplicateSourceDescription,
  draftToCollaborators,
  getDuplicateBannerMessage,
  RoyaltyConfigDraft,
} from "../configDuplication";

describe("Configuration Duplication", () => {
  const mockCollaborators = [
    {
      address: "GABC123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABC",
      basisPoints: 50,
    },
    {
      address: "GXYZ987654321ZYXWVUTSRQPONMLKJIHGFEDCBA9876543210XYZ",
      basisPoints: 50,
    },
  ];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-15T10:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("duplicateConfiguration", () => {
    it("should create a valid draft from collaborators", () => {
      const draft = duplicateConfiguration(mockCollaborators, "CCONTRACT123");

      expect(draft.isDuplicate).toBe(true);
      expect(draft.sourceContractId).toBe("CCONTRACT123");
      expect(draft.collaborators).toHaveLength(2);
      expect(draft.collaborators[0].address).toBe(mockCollaborators[0].address);
      expect(draft.collaborators[0].basisPoints).toBe("50");
    });

    it("should convert numeric basisPoints to strings", () => {
      const collaborators = [
        { address: mockCollaborators[0].address, basisPoints: 75 },
      ];
      const draft = duplicateConfiguration(collaborators);

      expect(typeof draft.collaborators[0].basisPoints).toBe("string");
      expect(draft.collaborators[0].basisPoints).toBe("75");
    });

    it("should preserve string basisPoints", () => {
      const collaborators = [
        { address: mockCollaborators[0].address, basisPoints: "25.5" },
      ];
      const draft = duplicateConfiguration(collaborators);

      expect(draft.collaborators[0].basisPoints).toBe("25.5");
    });

    it("should set duplicatedAt timestamp", () => {
      const draft = duplicateConfiguration(mockCollaborators);

      expect(draft.duplicatedAt).toBe("2024-01-15T10:00:00.000Z");
    });

    it("should throw on empty collaborators", () => {
      expect(() => duplicateConfiguration([])).toThrow(
        "Cannot duplicate: no collaborators to copy",
      );
    });

    it("should not modify source collaborators", () => {
      const source = [...mockCollaborators];
      duplicateConfiguration(mockCollaborators, "CCONTRACT123");

      expect(mockCollaborators).toEqual(source);
    });

    it("should handle large numbers of collaborators", () => {
      const largeList = Array.from({ length: 50 }, (_, i) => ({
        address: `GABC${i.toString().padStart(52, "0")}`,
        basisPoints: 2,
      }));

      const draft = duplicateConfiguration(largeList);

      expect(draft.collaborators).toHaveLength(50);
    });
  });

  describe("isValidDuplicateConfiguration", () => {
    let validDraft: RoyaltyConfigDraft;

    beforeEach(() => {
      validDraft = duplicateConfiguration(mockCollaborators);
    });

    it("should validate a correct duplicate configuration", () => {
      expect(isValidDuplicateConfiguration(validDraft)).toBe(true);
    });

    it("should reject non-duplicate configs", () => {
      validDraft.isDuplicate = false;

      expect(isValidDuplicateConfiguration(validDraft)).toBe(false);
    });

    it("should reject missing duplicatedAt", () => {
      validDraft.duplicatedAt = "";

      expect(isValidDuplicateConfiguration(validDraft)).toBe(false);
    });

    it("should reject invalid collaborator structure", () => {
      (validDraft.collaborators as unknown) = [
        { address: "GABC123", basisPoints: "50" },
        { address: "GXYZ987" },
      ];

      expect(isValidDuplicateConfiguration(validDraft)).toBe(false);
    });

    it("should reject empty collaborators array", () => {
      validDraft.collaborators = [];

      expect(isValidDuplicateConfiguration(validDraft)).toBe(false);
    });

    it("should reject non-array collaborators", () => {
      (validDraft.collaborators as unknown) = {
        address: "GABC",
        basisPoints: "50",
      };

      expect(isValidDuplicateConfiguration(validDraft)).toBe(false);
    });
  });

  describe("getDuplicateSourceDescription", () => {
    it("should format contract ID for display", () => {
      const draft = duplicateConfiguration(
        mockCollaborators,
        "CCONTRACT123456",
      );

      const desc = getDuplicateSourceDescription(draft);

      expect(desc).toContain("CCONTRA...");
    });

    it("should provide fallback for missing contract ID", () => {
      const draft = duplicateConfiguration(mockCollaborators);
      draft.sourceContractId = undefined;

      const desc = getDuplicateSourceDescription(draft);

      expect(desc).toBe("Configuration");
    });
  });

  describe("draftToCollaborators", () => {
    it("should convert draft to collaborator format", () => {
      const draft = duplicateConfiguration(mockCollaborators);

      const collaborators = draftToCollaborators(draft);

      expect(collaborators).toHaveLength(2);
      expect(collaborators[0]).toEqual({
        address: mockCollaborators[0].address,
        basisPoints: "50",
      });
    });

    it("should maintain order", () => {
      const ordered = [
        { address: "GAAA" as unknown as string, basisPoints: 10 },
        { address: "GBBB" as unknown as string, basisPoints: 20 },
        { address: "GCCC" as unknown as string, basisPoints: 70 },
      ];
      const draft = duplicateConfiguration(
        ordered as Array<{ address: string; basisPoints: number }>,
      );

      const result = draftToCollaborators(draft);

      expect(result[0].address).toContain("AAA");
      expect(result[1].address).toContain("BBB");
      expect(result[2].address).toContain("CCC");
    });
  });

  describe("getDuplicateBannerMessage", () => {
    it("should generate banner message with single collaborator", () => {
      const draft = duplicateConfiguration(
        [{ address: mockCollaborators[0].address, basisPoints: 100 }],
        "CCONTRACT123456",
      );

      const msg = getDuplicateBannerMessage(draft);

      expect(msg).toContain("1 collaborator");
      expect(msg).toContain("CCONTRA...");
      expect(msg).toContain("draft");
    });

    it("should generate banner message with multiple collaborators", () => {
      const draft = duplicateConfiguration(mockCollaborators, "CCONTRACT123");

      const msg = getDuplicateBannerMessage(draft);

      expect(msg).toContain("2 collaborators");
    });

    it("should include draft disclaimer", () => {
      const draft = duplicateConfiguration(mockCollaborators);

      const msg = getDuplicateBannerMessage(draft);

      expect(msg).toContain("draft");
      expect(msg).toContain("won't affect the original");
    });
  });

  describe("Integration scenarios", () => {
    it("should handle full duplication workflow", () => {
      const draft = duplicateConfiguration(mockCollaborators, "CORIGINAL");
      expect(isValidDuplicateConfiguration(draft)).toBe(true);

      const description = getDuplicateSourceDescription(draft);
      expect(description).toContain("CORIGIN...");

      const formCollaborators = draftToCollaborators(draft);
      expect(formCollaborators).toHaveLength(2);
      expect(formCollaborators[0].basisPoints).toBe("50");

      const banner = getDuplicateBannerMessage(draft);
      expect(banner).toContain("2 collaborators");
    });

    it("should preserve data integrity through duplication cycle", () => {
      const original = [
        { address: "GABC", basisPoints: 33.33 },
        { address: "GDEF", basisPoints: 33.33 },
        { address: "GHIJ", basisPoints: 33.34 },
      ];

      const draft = duplicateConfiguration(original);
      const recovered = draftToCollaborators(draft);

      expect(recovered).toHaveLength(3);
      expect(recovered.every((c) => typeof c.basisPoints === "string")).toBe(
        true,
      );
      expect(recovered.map((c) => c.address)).toEqual(
        original.map((c) => c.address),
      );
    });
  });
});
