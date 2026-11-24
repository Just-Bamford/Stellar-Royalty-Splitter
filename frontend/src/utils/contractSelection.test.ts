import { describe, it, expect } from "vitest";
import { areAllContractsSelected, toggleSelectAllContracts } from "./contractSelection";

describe("areAllContractsSelected", () => {
  it("is false when there are no contracts", () => {
    expect(areAllContractsSelected(new Set(), [])).toBe(false);
  });

  it("is false when only some contracts are selected", () => {
    expect(areAllContractsSelected(new Set(["A"]), ["A", "B", "C"])).toBe(false);
  });

  it("is true when every contract is selected", () => {
    expect(areAllContractsSelected(new Set(["A", "B"]), ["A", "B"])).toBe(true);
  });

  it("is not fooled by equal set sizes when the data changed", () => {
    // Old size-based check: selected.size (3) === contracts.length (3) would
    // report "all selected" even though D and E were never selected.
    const selected = new Set(["A", "B", "C"]);
    expect(areAllContractsSelected(selected, ["A", "D", "E"])).toBe(false);
  });

  it("ignores stale IDs that are no longer in the data", () => {
    const selected = new Set(["A", "B", "GONE"]);
    expect(areAllContractsSelected(selected, ["A", "B"])).toBe(true);
  });
});

describe("toggleSelectAllContracts", () => {
  it("selects every contract from a partial selection", () => {
    const next = toggleSelectAllContracts(new Set(["A"]), ["A", "B", "C"]);
    expect([...next].sort()).toEqual(["A", "B", "C"]);
  });

  it("clears the selection when all contracts are already selected", () => {
    const next = toggleSelectAllContracts(new Set(["A", "B"]), ["A", "B"]);
    expect(next.size).toBe(0);
  });

  it("selects all when the size matches but the IDs differ", () => {
    const next = toggleSelectAllContracts(new Set(["A", "B", "C"]), ["A", "D", "E"]);
    expect([...next].sort()).toEqual(["A", "D", "E"]);
  });

  it("does not mutate the input set", () => {
    const selected = new Set(["A"]);
    const next = toggleSelectAllContracts(selected, ["A", "B"]);
    expect([...selected]).toEqual(["A"]);
    expect(next).not.toBe(selected);
  });

  it("returns a new empty set on a second toggle", () => {
    const first = toggleSelectAllContracts(new Set(), ["A", "B"]);
    const second = toggleSelectAllContracts(first, ["A", "B"]);
    expect(second.size).toBe(0);
    expect(second).not.toBe(first);
  });
});
