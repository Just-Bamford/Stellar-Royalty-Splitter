export type FeatureName = 'dashboard' | 'split_royalties' | 'analytics' | 'settings' | 'history';

export interface UserBehavior {
  clicks: Record<string, number>;
  timeSpent: Record<string, number>;
  featuresUsed: FeatureName[];
  lastSession: number;
}

export type UserProfile = 'newbie' | 'casual' | 'power_user';

class PersonalizationEngine {
  private behavior: UserBehavior;
  private trackingInterval: ReturnType<typeof setInterval> | null = null;
  private currentFeature: FeatureName | null = null;
  private sessionStart: number = Date.now();

  constructor() {
    this.behavior = this.loadBehavior();
  }

  private loadBehavior(): UserBehavior {
    try {
      const stored = localStorage.getItem('userBehavior');
      if (stored) {
        return { ...this.getDefaultBehavior(), ...JSON.parse(stored) };
      }
    } catch (e) {
      console.error('Failed to load behavior', e);
    }
    return this.getDefaultBehavior();
  }
  
  private getDefaultBehavior(): UserBehavior {
    return {
      clicks: {},
      timeSpent: {},
      featuresUsed: [],
      lastSession: Date.now(),
    };
  }

  private saveBehavior() {
    try {
      localStorage.setItem('userBehavior', JSON.stringify(this.behavior));
    } catch (e) {
      console.error('Failed to save behavior', e);
    }
  }

  public trackClick(elementId: string) {
    this.behavior.clicks[elementId] = (this.behavior.clicks[elementId] || 0) + 1;
    this.saveBehavior();
  }

  public trackFeatureUsage(feature: FeatureName) {
    if (!this.behavior.featuresUsed.includes(feature)) {
      this.behavior.featuresUsed.push(feature);
    }
    if (this.currentFeature !== feature) {
      this.updateTimeSpent();
      this.currentFeature = feature;
      this.sessionStart = Date.now();
    }
    this.saveBehavior();
  }

  public updateTimeSpent() {
    if (this.currentFeature) {
      const elapsed = (Date.now() - this.sessionStart) / 1000;
      this.behavior.timeSpent[this.currentFeature] = (this.behavior.timeSpent[this.currentFeature] || 0) + elapsed;
      this.sessionStart = Date.now();
      this.saveBehavior();
    }
  }

  public startTracking() {
    if (this.trackingInterval) return;
    this.trackingInterval = setInterval(() => {
      this.updateTimeSpent();
    }, 5000);
  }

  public stopTracking() {
    if (this.trackingInterval) {
      clearInterval(this.trackingInterval);
      this.trackingInterval = null;
    }
    this.updateTimeSpent();
  }

  public getUserProfile(): UserProfile {
    const totalTime = Object.values(this.behavior.timeSpent).reduce((a, b) => a + b, 0);
    const uniqueFeatures = this.behavior.featuresUsed.length;
    const totalClicks = Object.values(this.behavior.clicks).reduce((a, b) => a + b, 0);

    if (totalTime > 3600 || uniqueFeatures > 3 || totalClicks > 500) {
      return 'power_user';
    }
    if (totalTime > 600 || uniqueFeatures > 1 || totalClicks > 50) {
      return 'casual';
    }
    return 'newbie';
  }
  
  public getFrequentlyUsedFeatures(): FeatureName[] {
    const sorted = [...this.behavior.featuresUsed].sort((a, b) => {
      const timeA = this.behavior.timeSpent[a] || 0;
      const timeB = this.behavior.timeSpent[b] || 0;
      return timeB - timeA;
    });
    return sorted.slice(0, 3);
  }
  
  public getRarelyUsedFeatures(): FeatureName[] {
      const allFeatures: FeatureName[] = ['dashboard', 'split_royalties', 'analytics', 'settings', 'history'];
      return allFeatures.filter(f => !this.getFrequentlyUsedFeatures().includes(f));
  }
}

export const personalizationService = new PersonalizationEngine();
