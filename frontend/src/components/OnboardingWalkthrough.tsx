import { useState, useEffect } from "react";
import "./OnboardingWalkthrough.css";

interface OnboardingStep {
  id: string;
  title: string;
  description: string;
  targetElement: string;
  position: "top" | "bottom" | "left" | "right";
}

const STEPS: OnboardingStep[] = [
  {
    id: "connect-wallet",
    title: "Connect Your Wallet",
    description:
      "Start by connecting your Stellar wallet using Freighter. This allows you to sign transactions.",
    targetElement: ".wallet-status",
    position: "bottom",
  },
  {
    id: "set-contract",
    title: "Enter Contract ID",
    description:
      "Paste your smart contract ID (starts with 'C') in the sidebar. This is the contract you want to manage.",
    targetElement: ".contract-input",
    position: "bottom",
  },
  {
    id: "distribute",
    title: "Distribute Funds",
    description:
      "Once set up, you can distribute royalties to your collaborators. Select a token and amount, then confirm with Freighter.",
    targetElement: '[aria-current="page"]',
    position: "right",
  },
];

const STORAGE_KEY = "srs_onboarding_completed";

interface OnboardingWalkthroughProps {
  onComplete?: () => void;
}

export const OnboardingWalkthrough: React.FC<OnboardingWalkthroughProps> = ({
  onComplete,
}) => {
  const [currentStep, setCurrentStep] = useState(0);
  const [isVisible, setIsVisible] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number }>({
    top: 0,
    left: 0,
  });

  useEffect(() => {
    const completed = localStorage.getItem(STORAGE_KEY);
    if (!completed) {
      setIsVisible(true);
    }
  }, []);

  useEffect(() => {
    if (!isVisible) return;

    const step = STEPS[currentStep];
    const targetElement = document.querySelector(step.targetElement);

    if (targetElement) {
      const rect = targetElement.getBoundingClientRect();
      const scrollTop =
        window.pageYOffset || document.documentElement.scrollTop;
      const scrollLeft =
        window.pageXOffset || document.documentElement.scrollLeft;

      let top = rect.top + scrollTop;
      let left = rect.left + scrollLeft;

      switch (step.position) {
        case "bottom":
          top = rect.bottom + scrollTop + 10;
          left = rect.left + scrollLeft;
          break;
        case "top":
          top = rect.top + scrollTop - 10;
          left = rect.left + scrollLeft;
          break;
        case "left":
          top = rect.top + scrollTop;
          left = rect.left + scrollLeft - 10;
          break;
        case "right":
          top = rect.top + scrollTop;
          left = rect.right + scrollLeft + 10;
          break;
      }

      setPosition({ top, left });
    }
  }, [isVisible, currentStep]);

  function nextStep() {
    if (currentStep < STEPS.length - 1) {
      setCurrentStep(currentStep + 1);
    } else {
      completeWalkthrough();
    }
  }

  function skipWalkthrough() {
    completeWalkthrough();
  }

  function completeWalkthrough() {
    localStorage.setItem(STORAGE_KEY, "true");
    setIsVisible(false);
    onComplete?.();
  }

  if (!isVisible) {
    return null;
  }

  const step = STEPS[currentStep];
  const isLastStep = currentStep === STEPS.length - 1;

  return (
    <>
      <div className="onboarding-overlay" onClick={skipWalkthrough} />
      <div
        className="onboarding-tooltip"
        style={{
          top: `${position.top}px`,
          left: `${position.left}px`,
        }}
      >
        <div className="onboarding-header">
          <h3>{step.title}</h3>
          <button
            className="onboarding-close"
            onClick={skipWalkthrough}
            aria-label="Close walkthrough"
          >
            ✕
          </button>
        </div>
        <p className="onboarding-description">{step.description}</p>
        <div className="onboarding-progress">
          <span className="onboarding-step-count">
            Step {currentStep + 1} of {STEPS.length}
          </span>
          <div className="onboarding-progress-bar">
            <div
              className="onboarding-progress-fill"
              style={{
                width: `${((currentStep + 1) / STEPS.length) * 100}%`,
              }}
            />
          </div>
        </div>
        <div className="onboarding-actions">
          <button
            className="onboarding-btn-skip"
            onClick={skipWalkthrough}
            type="button"
          >
            Skip
          </button>
          <button
            className="onboarding-btn-next"
            onClick={nextStep}
            type="button"
          >
            {isLastStep ? "Finish" : "Next"}
          </button>
        </div>
      </div>
    </>
  );
};
