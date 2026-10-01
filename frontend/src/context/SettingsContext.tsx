import React, { createContext, useContext } from "react";
import {
  useSettingsStore,
  type SettingsType as BaseSettingsType,
} from "../store/settingsStore";
import {
  useContractsStore,
  isValidContractId,
  normalizeContractList,
} from "../store/contractsStore";

export { isValidContractId, normalizeContractList };

export interface SettingsType extends BaseSettingsType {
  trackedContracts: string[];
}

interface SettingsContextType {
  settings: SettingsType;
  updateSettings: (patch: Partial<BaseSettingsType>) => void;
  addTrackedContract: (contractId: string) => boolean;
  removeTrackedContract: (contractId: string) => void;
}

export const DEFAULTS: SettingsType = {
  autoSaveAuditLog: true,
  notifyOnDistribution: true,
  displayCurrency: "XLM",
  language: "en",
  maxPayoutsPerTransaction: 10,
  minPayoutAmount: 0.1,
  trackedContracts: [],
};

const SettingsContext = createContext<SettingsContextType | undefined>(
  undefined,
);

export const SettingsProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const baseSettings = useSettingsStore((s) => s.settings);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const trackedContracts = useContractsStore((s) => s.trackedContracts);
  const addTrackedContract = useContractsStore((s) => s.addTrackedContract);
  const removeTrackedContract = useContractsStore((s) => s.removeTrackedContract);
  const settings: SettingsType = {
    ...DEFAULTS,
    ...baseSettings,
    trackedContracts,
  };

  return (
    <SettingsContext.Provider
      value={{ settings, updateSettings, addTrackedContract, removeTrackedContract }}
    >
      {children}
    </SettingsContext.Provider>
  );
};

export const useSettings = (): SettingsContextType => {
  const context = useContext(SettingsContext);
  const baseSettings = useSettingsStore((s) => s.settings);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const trackedContracts = useContractsStore((s) => s.trackedContracts);
  const addTrackedContract = useContractsStore((s) => s.addTrackedContract);
  const removeTrackedContract = useContractsStore((s) => s.removeTrackedContract);

  if (context) {
    return context;
  }
  return {
    settings: { ...DEFAULTS, ...baseSettings, trackedContracts },
    updateSettings,
    addTrackedContract,
    removeTrackedContract,
  };
};

export default SettingsProvider;
