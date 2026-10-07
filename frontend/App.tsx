import { Suspense, lazy, useEffect } from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { RTL_LANGUAGES, type SupportedLanguage } from "./src/i18n/languages";

// Trigger frontend CI workflow
const HomePage = lazy(() => import("./HomePage"));
const DashboardPage = lazy(() => import("./DashboardPage"));

function App() {
  const { i18n } = useTranslation();

  useEffect(() => {
    const language = i18n.language.split("-")[0] as SupportedLanguage;
    const root = document.documentElement;
    root.lang = language;
    root.dir = RTL_LANGUAGES.has(language) ? "rtl" : "ltr";
  }, [i18n.language]);

  return (
    <BrowserRouter>
      <Suspense fallback={<div>Loading...</div>}>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/dashboard" element={<DashboardPage />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}

export default App;
