import { useTranslation } from "react-i18next";
import { useSettings } from "../context/SettingsContext";

const LANGUAGES = [
  { code: "en", name: "English", nativeName: "English" },
  { code: "es", name: "Spanish", nativeName: "Español" },
  { code: "de", name: "German", nativeName: "Deutsch" },
  { code: "zh", name: "Chinese (Simplified)", nativeName: "中文 (简体)" },
] as const;

export const LanguageSelector: React.FC = () => {
  const { i18n } = useTranslation();
  const { settings, updateSettings } = useSettings();

  const currentLanguage = LANGUAGES.find((lang) => lang.code === i18n.language) || LANGUAGES[0];

  const handleLanguageChange = (languageCode: string) => {
    i18n.changeLanguage(languageCode);
    updateSettings({ language: languageCode } as any);
  };

  return (
    <div className="setting-item">
      <div className="setting-label">
        <label htmlFor="language">Language / Idioma / Sprache / 语言</label>
        <p className="setting-description">
          Select your preferred language / Seleccione su idioma preferido / Wählen Sie Ihre bevorzugte Sprache / 选择您的首选语言
        </p>
      </div>
      <select
        id="language"
        value={currentLanguage.code}
        onChange={(e) => handleLanguageChange(e.target.value)}
        className="setting-select"
        aria-label="Select language"
      >
        {LANGUAGES.map((lang) => (
          <option key={lang.code} value={lang.code}>
            {lang.nativeName}
          </option>
        ))}
      </select>
    </div>
  );
};