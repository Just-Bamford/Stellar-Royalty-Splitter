import { describe, it, expect } from "vitest";
import { isCollaborator, findCollaborator } from "../collaborators";

describe("collaborators (#746)", () => {
  const collaborators = [
    { address: "GABC123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABC", basisPoints: 6000 },
    { address: "GXYZ987654321ZYXWVUTSRQPONMLKJIHGFEDCBA9876543210XYZ", basisPoints: 4000 },
  ];

  describe("isCollaborator", () => {
    it("returns true for a known collaborator address", () => {
      expect(isCollaborator(collaborators, collaborators[0].address)).toBe(true);
      expect(isCollaborator(collaborators, collaborators[1].address)).toBe(true);
    });

    it("returns false for an unknown address", () => {
      expect(
        isCollaborator(collaborators, "GNOTACOLLABORATOR00000000000000000000000000000000"),
      ).toBe(false);
    });

    it("returns false for a null/undefined/empty address", () => {
      expect(isCollaborator(collaborators, null)).toBe(false);
      expect(isCollaborator(collaborators, undefined)).toBe(false);
      expect(isCollaborator(collaborators, "")).toBe(false);
    });

    it("returns false when the collaborator list is null, undefined, or empty", () => {
      expect(isCollaborator(null, collaborators[0].address)).toBe(false);
      expect(isCollaborator(undefined, collaborators[0].address)).toBe(false);
      expect(isCollaborator([], collaborators[0].address)).toBe(false);
    });

    it("is an exact, case-sensitive match", () => {
      const lower = collaborators[0].address.toLowerCase();
      expect(isCollaborator(collaborators, lower)).toBe(false);
    });
  });

  describe("findCollaborator", () => {
    it("returns the matching collaborator entry", () => {
      expect(findCollaborator(collaborators, collaborators[1].address)).toEqual(
        collaborators[1],
      );
    });

    it("returns undefined for an unknown address", () => {
      expect(
        findCollaborator(collaborators, "GNOTACOLLABORATOR00000000000000000000000000000000"),
      ).toBeUndefined();
    });

    it("returns undefined for a null/undefined address or empty list", () => {
      expect(findCollaborator(collaborators, null)).toBeUndefined();
      expect(findCollaborator([], collaborators[0].address)).toBeUndefined();
    });
  });
});
