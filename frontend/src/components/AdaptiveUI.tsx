import React, { useEffect, useState } from 'react';
import { personalizationService, FeatureName, UserProfile } from '../services/personalization';
import { usePreferences } from '../contexts/PreferencesContext';

export const AdaptiveUI: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { preferences } = usePreferences();
  const [profile, setProfile] = useState<UserProfile>('newbie');
  const [frequent, setFrequent] = useState<FeatureName[]>([]);

  useEffect(() => {
    if (preferences.dataPrivacy.allowTracking) {
      personalizationService.startTracking();
    } else {
      personalizationService.stopTracking();
    }
    return () => personalizationService.stopTracking();
  }, [preferences.dataPrivacy.allowTracking]);

  useEffect(() => {
    const interval = setInterval(() => {
      setProfile(personalizationService.getUserProfile());
      setFrequent(personalizationService.getFrequentlyUsedFeatures());
    }, 10000);
    
    setProfile(personalizationService.getUserProfile());
    setFrequent(personalizationService.getFrequentlyUsedFeatures());

    return () => clearInterval(interval);
  }, []);

  return (
    <div className={`theme-${preferences.theme} lang-${preferences.language} units-${preferences.units}`}>
      <div className={`adaptive-wrapper profile-${profile}`}>
        {children}
      </div>
    </div>
  );
};

export const AdaptiveWidget: React.FC<{ feature: FeatureName, children: React.ReactNode, hideIfRare?: boolean }> = ({ feature, children, hideIfRare }) => {
    const [isFrequent, setIsFrequent] = useState(false);
    const [isRare, setIsRare] = useState(false);

    useEffect(() => {
        const checkStatus = () => {
            const frequent = personalizationService.getFrequentlyUsedFeatures();
            const rare = personalizationService.getRarelyUsedFeatures();
            setIsFrequent(frequent.includes(feature));
            setIsRare(rare.includes(feature));
        };
        checkStatus();
        const interval = setInterval(checkStatus, 10000);
        return () => clearInterval(interval);
    }, [feature]);

    if (hideIfRare && isRare) {
        return null;
    }

    return (
        <div className={`adaptive-widget ${isFrequent ? 'highlight-prominent' : ''}`} onClick={() => personalizationService.trackFeatureUsage(feature)}>
            {children}
        </div>
    );
};

export const NewFeatureTip: React.FC<{ feature: FeatureName, message: string }> = ({ feature, message }) => {
    const [showTip, setShowTip] = useState(false);
    useEffect(() => {
        const profile = personalizationService.getUserProfile();
        const rare = personalizationService.getRarelyUsedFeatures();
        if ((profile === 'newbie' || profile === 'casual') && rare.includes(feature)) {
            setShowTip(true);
        }
    }, [feature]);

    if (!showTip) return null;
    return <div className="helpful-tip">{message}</div>;
};
