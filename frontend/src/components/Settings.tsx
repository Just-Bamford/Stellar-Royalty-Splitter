import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useTheme } from "../context/ThemeContext";
import {
  useSettings,
  SettingsType,
  isValidContractId,
} from "../context/SettingsContext";
import { useUIStore } from "../store/uiStore";
import { useSettingsStore } from "../store/settingsStore";
import { useContractsStore } from "../store/contractsStore";

import { CopyButton } from "./CopyButton";
import { PaymentPreferences } from "./PaymentPreferences";
import { NotificationPreferences } from "./NotificationPreferences";
import { LanguageSelector } from "./LanguageSelector";
import "./Settings.css";

interface SettingsProps {
  contractId: string;
  walletAddress?: string | null;
  onClearContract?: () => void;
}

export const Settings: React.FC<SettingsProps> = ({
  contractId,
  walletAddress,
  onClearContract,
}) => {
  const isDark = useUIStore((s) => s.isDark);
  const toggleTheme = useUIStore((s) => s.toggleTheme);
  const settings = useSettingsStore((s) => s.settings);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const trackedContracts = useContractsStore((s) => s.trackedContracts);
  const addTrackedContract = useContractsStore((s) => s.addTrackedContract);
  const removeTrackedContract = useContractsStore((s) => s.removeTrackedContract);
  const [localSettings, setLocalSettings] = useState(() => ({ ...settings, trackedContracts }));

  const [saveStatus, setSaveStatus] = useState<string | null>(null);
  const [newContractId, setNewContractId] = useState("");
  const [contractError, setContractError] = useState<string | null>(null);

  const handleToggle = (key: keyof typeof localSettings) => {
    const newValue = !localSettings[key];
    setLocalSettings({ ...localSettings, [key]: newValue });
    showSaveStatus("Saving...");
  };

  const handleChange = (key: keyof typeof localSettings, value: string | number) => {
    setLocalSettings({ ...localSettings, [key]: value });
  };

  const handleDarkMode = () => {
    toggleTheme();
    showSaveStatus("✓ Theme updated!");
  };

  const handleSave = () => {
    // Persist via SettingsContext (saves to localStorage)
    updateSettings(localSettings);
    showSaveStatus("✓ Settings saved successfully!");
  };

  const handleReset = () => {
    if (window.confirm("Reset all settings to defaults?")) {
      const defaults: SettingsType = {
        autoSaveAuditLog: true,
        notifyOnDistribution: true,
        displayCurrency: "XLM",
        maxPayoutsPerTransaction: 10,
        minPayoutAmount: 0.1,
        trackedContracts: [],
        language: "en",
      };
      setLocalSettings(defaults);
      updateSettings(defaults);
      showSaveStatus("✓ Settings reset to defaults!");
    }
  };

  const handleAddContract = () => {
    const trimmed = newContractId.trim();
    if (!isValidContractId(trimmed)) {
      setContractError("Contract ID must start with C and be 56 characters");
      return;
    }
    if (!addTrackedContract(trimmed)) {
      setContractError("This contract is already being tracked");
      return;
    }
    setLocalSettings((s) => ({
      ...s,
      trackedContracts: Array.from(new Set([...s.trackedContracts, trimmed])),
    }));
    setNewContractId("");
    setContractError(null);
    showSaveStatus("✓ Contract added to tracked list!");
  };

  const handleRemoveContract = (id: string) => {
    removeTrackedContract(id);
    setLocalSettings((s) => ({
      ...s,
      trackedContracts: s.trackedContracts.filter((c) => c !== id),
    }));
    showSaveStatus("✓ Contract removed from tracked list!");
  };

  const { t } = useTranslation();
  const showSaveStatus = (message: string) => {
    setSaveStatus(message);
    setTimeout(() => setSaveStatus(null), 3000);
  };

  return (
    <div className="settings">
      <div className="settings-header">
        <h1>⚙️ {t("settings.title")}</h1>
        <p className="settings-subtitle settings-contract-id">
          <span>{t("dashboard.contractId")}: {contractId || t("wallet.disconnected")}</span>
          {contractId && (
            <CopyButton value={contractId} label="contract ID" size="sm" />
          )}
        </p>
      </div>

      {saveStatus && <div className="save-status">{saveStatus}</div>}

      <div className="settings-content">
        {/* General Settings */}
        <section className="settings-section">
          <h2 className="section-title">{t("settings.general")}</h2>

          <div className="setting-item">
            <div className="setting-label">
              <label htmlFor="currency">{t("settings.displayCurrency")}</label>
              <p className="setting-description">
                {t("settings.currencyDescription")}
              </p>
            </div>
            <select
              id="currency"
              value={localSettings.displayCurrency}
              onChange={(e) => handleChange("displayCurrency", e.target.value)}
              className="setting-select"
            >
              <option value="XLM">Stellar Lumens (XLM)</option>
              <option value="USD">US Dollars (USD)</option>
              <option value="EUR">Euros (EUR)</option>
            </select>
          </div>

          <div className="setting-item">
            <div className="setting-label">
              <label htmlFor="darkMode">{t("settings.darkMode")}</label>
              <p className="setting-description">
                {t("settings.darkModeDescription")}
              </p>
            </div>
            <button
              className={`toggle-btn ${isDark ? "active" : ""}`}
              onClick={handleDarkMode}
              id="darkMode"
            >
              {isDark ? t("common.on") : t("common.off")}
            </button>
          </div>

          <LanguageSelector />
        </section>

        {/* Tracked Contracts */}
        <section className="settings-section">
          <h2 className="section-title">{t("settings.trackedContracts")}</h2>
          <p className="setting-description">
            {t("settings.trackedContractsDescription")}
          </p>

          <div className="setting-item">
            <div className="setting-label">
              <label htmlFor="newContractId">{t("settings.addContractId")}</label>
            </div>
            <div style={{ display: "flex", gap: "0.5rem", width: "100%" }}>
              <input
                id="newContractId"
                type="text"
                placeholder={t("settings.addContractPlaceholder")}
                value={newContractId}
                onChange={(e) => {
                  setNewContractId(e.target.value);
                  setContractError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleAddContract();
                }}
                className="setting-input"
              />
              <button
                type="button"
                className="btn-primary"
                onClick={handleAddContract}
              >
                {t("settings.addButton")}
              </button>
            </div>
          </div>
          {contractError && (
            <p role="alert" className="contract-input-error">
              {contractError}
            </p>
          )}

          {trackedContracts.length === 0 ? (
            <p className="setting-description">
              {t("settings.noContractsTracked")}
            </p>
          ) : (
            <ul className="tracked-contracts-list" aria-label="Tracked contracts">
              {trackedContracts.map((id) => (
                <li key={id} className="tracked-contract-item">
                  <span title={id}>{id}</span>
                  {id === contractId && (
                    <span className="you-badge">{t("common.active")}</span>
                  )}
                  <CopyButton value={id} label="contract ID" size="sm" />
                  <button
                    type="button"
                    aria-label={`Remove contract ${id}`}
                    onClick={() => handleRemoveContract(id)}
                  >
                    {t("settings.removeContract")}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Distribution Settings */}
        <section className="settings-section">
          <h2 className="section-title">{t("settings.distribution")}</h2>

          <div className="setting-item">
            <div className="setting-label">
              <label htmlFor="maxPayouts">{t("settings.maxPayouts")}</label>
              <p className="setting-description">
                {t("settings.maxPayoutsDescription")}
              </p>
            </div>
            <input
              id="maxPayouts"
              type="number"
              min="1"
              max="100"
              value={localSettings.maxPayoutsPerTransaction}
              onChange={(e) =>
                handleChange(
                  "maxPayoutsPerTransaction",
                  parseInt(e.target.value),
                )
              }
              className="setting-input"
            />
          </div>

          <div className="setting-item">
            <div className="setting-label">
              <label htmlFor="minPayout">{t("settings.minPayout")}</label>
              <p className="setting-description">
                {t("settings.minPayoutDescription")}
              </p>
            </div>
            <input
              id="minPayout"
              type="number"
              min="0.1"
              step="0.1"
              value={localSettings.minPayoutAmount}
              onChange={(e) =>
                handleChange("minPayoutAmount", parseFloat(e.target.value))
              }
              className="setting-input"
            />
          </div>

          <div className="setting-item">
            <div className="setting-label">
              <label htmlFor="autoSave">{t("settings.autoSaveAuditLog")}</label>
              <p className="setting-description">
                {t("settings.autoSaveAuditLogDescription")}
              </p>
            </div>
            <button
              className={`toggle-btn ${
                localSettings.autoSaveAuditLog ? "active" : ""
              }`}
              onClick={() => handleToggle("autoSaveAuditLog")}
              id="autoSave"
            >
              {localSettings.autoSaveAuditLog ? t("common.on") : t("common.off")}
            </button>
          </div>
        </section>

        {/* Notification Settings */}
        <section className="settings-section">
          <h2 className="section-title">{t("settings.notifications")}</h2>

          <div className="setting-item">
            <div className="setting-label">
              <label htmlFor="notifyDist">{t("settings.notifyOnDistribution")}</label>
              <p className="setting-description">
                {t("settings.notifyOnDistributionDescription")}
              </p>
            </div>
            <button
              className={`toggle-btn ${
                localSettings.notifyOnDistribution ? "active" : ""
              }`}
              onClick={() => handleToggle("notifyOnDistribution")}
              id="notifyDist"
            >
              {localSettings.notifyOnDistribution ? t("common.on") : t("common.off")}
            </button>
          </div>
        </section>

        {/* Payment Preferences */}
        <PaymentPreferences walletAddress={walletAddress ?? ""} />

        {/* Notification Preferences (#605) */}
        <NotificationPreferences walletAddress={walletAddress ?? ""} />

        {/* About Section */}
        <section className="settings-section">
          <h2 className="section-title">{t("settings.about")}</h2>
          <div className="about-content">
            <div className="about-item">
              <h3>{t("settings.title")}</h3>
              <p>{t("settings.version")} 1.0.0</p>
              <p className="about-description">
                {t("settings.description")}
              </p>
            </div>
            <div className="about-item">
              <h3>{t("settings.smartContract")}</h3>
              <p>{t("settings.sorobanRuntime")}</p>
              <p className="about-description">
                Built on Stellar Testnet for secure, transparent transactions.
              </p>
            </div>
            <div className="about-item">
              <h3>{t("settings.support")}</h3>
              <p>
                <a
                  href="https://stellar.org"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {t("settings.stellarDocs")}
                </a>
              </p>
              <p>
                <a
                  href="https://github.com"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {t("settings.githubRepo")}
                </a>
              </p>
            </div>
          </div>
        </section>
      </div>

      {/* Action Buttons */}
      <div className="settings-actions">
        <button className="btn-primary" onClick={handleSave}>
          💾 {t("settings.saveSettings")}
        </button>
        <button className="btn-secondary" onClick={handleReset}>
          🔄 {t("settings.resetToDefaults")}
        </button>
        {onClearContract && (
          <button className="btn-secondary" onClick={onClearContract}>
            🗑️ {t("settings.clearSavedContract")}
          </button>
        )}
      </div>
    </div>
  );
};
