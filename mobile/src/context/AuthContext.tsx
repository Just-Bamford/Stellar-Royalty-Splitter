import React, { createContext, useContext, useState, useEffect, ReactNode } from "react";
import { biometricsService, BiometryType } from "../services/biometrics";

interface AuthContextType {
  isUnlocked: boolean;
  biometryType: BiometryType;
  isBiometryEnabled: boolean;
  unlock: () => Promise<boolean>;
  lock: () => void;
  toggleBiometry: (enabled: boolean) => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [isUnlocked, setIsUnlocked] = useState(false);
  const [biometryType, setBiometryType] = useState<BiometryType>("FaceID");
  const [isBiometryEnabled, setIsBiometryEnabled] = useState(true);

  useEffect(() => {
    const init = async () => {
      const capability = await biometricsService.checkAvailability();
      setBiometryType(capability.biometryType);
    };
    void init();
  }, []);

  const unlock = async (): Promise<boolean> => {
    const res = await biometricsService.authenticate("Unlock Stellar Royalty Splitter");
    if (res.success) {
      setIsUnlocked(true);
      return true;
    }
    return false;
  };

  const lock = () => {
    setIsUnlocked(false);
  };

  const toggleBiometry = (enabled: boolean) => {
    setIsBiometryEnabled(enabled);
    biometricsService.setBiometryEnabled(enabled);
  };

  return (
    <AuthContext.Provider
      value={{
        isUnlocked,
        biometryType,
        isBiometryEnabled,
        unlock,
        lock,
        toggleBiometry,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
};
