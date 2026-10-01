import React, { createContext, useContext, useState, useEffect } from 'react';

export type Theme = 'light' | 'dark' | 'system';
export type Language = 'en' | 'es' | 'fr' | 'de';
export type Unit = 'USD' | 'XLM';
export type NotificationFrequency = 'realtime' | 'daily' | 'weekly' | 'never';

export interface Preferences {
  theme: Theme;
  language: Language;
  units: Unit;
  notificationFrequency: NotificationFrequency;
  dataPrivacy: {
    allowTracking: boolean;
    shareDataWithPartners: boolean;
  };
}

const defaultPreferences: Preferences = {
  theme: 'system',
  language: 'en',
  units: 'USD',
  notificationFrequency: 'daily',
  dataPrivacy: {
    allowTracking: true,
    shareDataWithPartners: false,
  },
};

interface PreferencesContextType {
  preferences: Preferences;
  updatePreference: <K extends keyof Preferences>(key: K, value: Preferences[K]) => void;
  exportPreferences: () => string;
  importPreferences: (data: string) => void;
}

const PreferencesContext = createContext<PreferencesContextType | undefined>(undefined);

export const PreferencesProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [preferences, setPreferences] = useState<Preferences>(() => {
    try {
      const stored = localStorage.getItem('userPreferences');
      if (stored) {
        return { ...defaultPreferences, ...JSON.parse(stored) };
      }
    } catch (e) {
      console.error('Failed to load preferences', e);
    }
    return defaultPreferences;
  });

  useEffect(() => {
    localStorage.setItem('userPreferences', JSON.stringify(preferences));
  }, [preferences]);

  const updatePreference = <K extends keyof Preferences>(key: K, value: Preferences[K]) => {
    setPreferences((prev) => ({
      ...prev,
      [key]: value,
    }));
  };

  const exportPreferences = () => {
    return JSON.stringify(preferences);
  };

  const importPreferences = (data: string) => {
    try {
      const parsed = JSON.parse(data);
      setPreferences({ ...defaultPreferences, ...parsed });
    } catch (e) {
      console.error('Failed to parse preferences', e);
    }
  };

  return (
    <PreferencesContext.Provider value={{ preferences, updatePreference, exportPreferences, importPreferences }}>
      {children}
    </PreferencesContext.Provider>
  );
};

export const usePreferences = () => {
  const context = useContext(PreferencesContext);
  if (!context) {
    throw new Error('usePreferences must be used within a PreferencesProvider');
  }
  return context;
};
