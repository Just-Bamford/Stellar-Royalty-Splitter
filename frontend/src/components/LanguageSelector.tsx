import { useTranslation } from "react-i18next";
import { useSettings } from "../context/SettingsContext";
import { SUPPORTED_LANGUAGES, type SupportedLanguage } from "../i18n/languages";

interface LanguageSelectorProps {
  compact?: boolean;
}

export const LanguageSelector: React.FC<LanguageSelectorProps> = ({ compact = false }) => {
  const { i18n, t } = useTranslation();
  const { updateSettings } = useSettings();

  const currentLanguage = SUPPORTED_LANGUAGES.find((lang) => lang.code === i18n.language.split("-")[0]) || SUPPORTED_LANGUAGES[0];

  const handleLanguageChange = (languageCode: SupportedLanguage) => {
    void i18n.changeLanguage(languageCode);
    updateSettings({ language: languageCode });
  };

  const select = (
    <select
      id={compact ? "quick-language" : "language"}
      value={currentLanguage.code}
      onChange={(e) => handleLanguageChange(e.target.value as SupportedLanguage)}
      className={compact ? "nav-language-select" : "setting-select"}
      aria-label={t("settings.language")}
    >
      {SUPPORTED_LANGUAGES.map((lang) => (
        <option key={lang.code} value={lang.code}>
          {lang.nativeName}
        </option>
      ))}
    </select>
  );

  if (compact) return select;

  return (
    <div className="setting-item">
      <div className="setting-label">
        <label htmlFor="language">{t("settings.language")}</label>
        <p className="setting-description">{t("settings.languageDescription")}</p>
      </div>
      {select}
    </div>
  );
};