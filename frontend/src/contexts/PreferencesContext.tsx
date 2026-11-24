import React, { createContext, useContext, useState, useEffect } from 'react';
import { analytics } from '../lib/analytics';

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
    // Opt-in only: analytics tracking requires an explicit user choice (#1238).
    allowTracking: false,
    shareDataWithPartners: false,
  },
};

const THEMES: readonly Theme[] = ['light', 'dark', 'system'];
const LANGUAGES: readonly Language[] = ['en', 'es', 'fr', 'de'];
const UNITS: readonly Unit[] = ['USD', 'XLM'];
const NOTIFICATION_FREQUENCIES: readonly NotificationFrequency[] = [
  'realtime',
  'daily',
  'weekly',
  'never',
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isOneOf = <T extends string>(value: unknown, allowed: readonly T[]): value is T =>
  typeof value === 'string' && (allowed as readonly string[]).includes(value);

const safeMerge = (base: Preferences, imported: unknown): Preferences => {
  const merged: Preferences = {
    ...base,
    dataPrivacy: { ...base.dataPrivacy },
  };

  if (!isRecord(imported)) {
    return merged;
  }

  if (isOneOf(imported.theme, THEMES)) {
    merged.theme = imported.theme;
  }
  if (isOneOf(imported.language, LANGUAGES)) {
    merged.language = imported.language;
  }
  if (isOneOf(imported.units, UNITS)) {
    merged.units = imported.units;
  }
  if (isOneOf(imported.notificationFrequency, NOTIFICATION_FREQUENCIES)) {
    merged.notificationFrequency = imported.notificationFrequency;
  }

  if (isRecord(imported.dataPrivacy)) {
    const { allowTracking, shareDataWithPartners } = imported.dataPrivacy;
    if (typeof allowTracking === 'boolean') {
      merged.dataPrivacy.allowTracking = allowTracking;
    }
    if (typeof shareDataWithPartners === 'boolean') {
      merged.dataPrivacy.shareDataWithPartners = shareDataWithPartners;
    }
  }

  return merged;
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

  useEffect(() => {
    analytics.setTrackingConsent(preferences.dataPrivacy.allowTracking);
  }, [preferences.dataPrivacy.allowTracking]);

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
      setPreferences(safeMerge(defaultPreferences, parsed));
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
