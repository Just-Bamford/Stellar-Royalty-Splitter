import { create } from "zustand";
import { devtools } from "zustand/middleware";

export interface ContractsState {
  trackedContracts: string[];
  activeContractId: string | null;
  addTrackedContract: (contractId: string) => boolean;
  removeTrackedContract: (contractId: string) => void;
  setTrackedContracts: (contracts: string[]) => void;
  setActiveContractId: (contractId: string | null) => void;
}

const SETTINGS_STORAGE_KEY = "royaltySplitterSettings";

// A contract ID on Stellar starts with "C" and is 56 characters long.
export function isValidContractId(id: string): boolean {
  return typeof id === "string" && id.startsWith("C") && id.length === 56;
}

export function normalizeContractList(contracts: string[]): string[] {
  return Array.from(new Set(contracts.map((c) => c.trim()).filter(isValidContractId)));
}

function getInitialTrackedContracts(): string[] {
  try {
    if (typeof window !== "undefined") {
      const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed.trackedContracts)) {
          return normalizeContractList(parsed.trackedContracts);
        }
      }
    }
  } catch (_) {}
  return [];
}

function syncTrackedContractsToLocalStorage(contracts: string[]) {
  try {
    if (typeof window !== "undefined") {
      const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
      const existing = raw ? JSON.parse(raw) : {};
      existing.trackedContracts = contracts;
      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(existing));
    }
  } catch (_) {}
}

export const useContractsStore = create<ContractsState>()(
  devtools(
    (set, get) => ({
      trackedContracts: getInitialTrackedContracts(),
      activeContractId: null,

      addTrackedContract: (contractId: string) => {
        const trimmed = contractId.trim();
        if (!isValidContractId(trimmed)) return false;
        const current = get().trackedContracts;
        if (current.includes(trimmed)) return false;
        const updated = [...current, trimmed];
        syncTrackedContractsToLocalStorage(updated);
        set({ trackedContracts: updated }, false, "contracts/addTrackedContract");
        return true;
      },

      removeTrackedContract: (contractId: string) => {
        const updated = get().trackedContracts.filter((c) => c !== contractId);
        syncTrackedContractsToLocalStorage(updated);
        set(
          (state) => ({
            trackedContracts: updated,
            activeContractId: state.activeContractId === contractId ? null : state.activeContractId,
          }),
          false,
          "contracts/removeTrackedContract",
        );
      },

      setTrackedContracts: (contracts: string[]) => {
        const normalized = normalizeContractList(contracts);
        syncTrackedContractsToLocalStorage(normalized);
        set({ trackedContracts: normalized }, false, "contracts/setTrackedContracts");
      },

      setActiveContractId: (contractId: string | null) => {
        set({ activeContractId: contractId }, false, "contracts/setActiveContractId");
      },
    }),
    { name: "ContractsStore" },
  ),
);
