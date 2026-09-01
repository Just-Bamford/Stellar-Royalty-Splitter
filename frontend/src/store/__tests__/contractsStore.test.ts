import { describe, it, expect, beforeEach } from "vitest";
import {
  useContractsStore,
  isValidContractId,
  normalizeContractList,
} from "../contractsStore";

const VALID_CONTRACT_1 = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const VALID_CONTRACT_2 = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const INVALID_CONTRACT = "invalid-contract-id";

describe("contractsStore", () => {
  beforeEach(() => {
    localStorage.clear();
    useContractsStore.setState({
      trackedContracts: [],
      activeContractId: null,
    });
  });

  describe("isValidContractId", () => {
    it("returns true for valid Stellar contract IDs (starts with C, 56 chars)", () => {
      expect(isValidContractId(VALID_CONTRACT_1)).toBe(true);
      expect(isValidContractId(VALID_CONTRACT_2)).toBe(true);
    });

    it("returns false for invalid contract IDs", () => {
      expect(isValidContractId(INVALID_CONTRACT)).toBe(false);
      expect(isValidContractId("C123")).toBe(false);
      expect(isValidContractId("G" + VALID_CONTRACT_1.slice(1))).toBe(false);
    });
  });

  describe("normalizeContractList", () => {
    it("filters invalid IDs, trims whitespace, and deduplicates", () => {
      const input = [
        ` ${VALID_CONTRACT_1} `,
        VALID_CONTRACT_1,
        INVALID_CONTRACT,
        VALID_CONTRACT_2,
      ];
      const result = normalizeContractList(input);
      expect(result).toEqual([VALID_CONTRACT_1, VALID_CONTRACT_2]);
    });
  });

  describe("store actions", () => {
    it("adds valid contract ID and updates trackedContracts", () => {
      const success = useContractsStore.getState().addTrackedContract(VALID_CONTRACT_1);
      expect(success).toBe(true);
      expect(useContractsStore.getState().trackedContracts).toContain(VALID_CONTRACT_1);
    });

    it("rejects invalid or duplicate contract IDs", () => {
      const invalidResult = useContractsStore.getState().addTrackedContract(INVALID_CONTRACT);
      expect(invalidResult).toBe(false);

      useContractsStore.getState().addTrackedContract(VALID_CONTRACT_1);
      const duplicateResult = useContractsStore.getState().addTrackedContract(VALID_CONTRACT_1);
      expect(duplicateResult).toBe(false);
      expect(useContractsStore.getState().trackedContracts).toHaveLength(1);
    });

    it("removes a contract ID from trackedContracts", () => {
      useContractsStore.getState().addTrackedContract(VALID_CONTRACT_1);
      useContractsStore.getState().addTrackedContract(VALID_CONTRACT_2);
      useContractsStore.getState().setActiveContractId(VALID_CONTRACT_1);

      useContractsStore.getState().removeTrackedContract(VALID_CONTRACT_1);
      expect(useContractsStore.getState().trackedContracts).toEqual([VALID_CONTRACT_2]);
      expect(useContractsStore.getState().activeContractId).toBeNull();
    });

    it("sets active contract ID", () => {
      useContractsStore.getState().setActiveContractId(VALID_CONTRACT_2);
      expect(useContractsStore.getState().activeContractId).toBe(VALID_CONTRACT_2);
    });

    it("sets tracked contracts list directly after normalizing", () => {
      useContractsStore.getState().setTrackedContracts([VALID_CONTRACT_1, INVALID_CONTRACT]);
      expect(useContractsStore.getState().trackedContracts).toEqual([VALID_CONTRACT_1]);
    });
  });
});
