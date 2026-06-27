import { useState, useEffect } from "react";
import "./OnboardingWalkthrough.css";

interface OnboardingStep {
  id: string;
  title: string;
  description: string;
  targetElement: string;
  position: "top" | "bottom" | "left" | "right";
  /** App page (App.tsx currentPage value) this step's target lives on, if any. */
  page?: string;
}

const STEPS: OnboardingStep[] = [
  {
    id: "initialize-overview",
    title: "Initialize Your Contract",
    description:
      "Start here. Initializing defines who your collaborators are and how royalties are split between them.",
    targetElement: '[data-tour-id="initialize"]',
    position: "bottom",
    page: "initialize",
  },
  {
    id: "add-collaborators",
    title: "Add Collaborators",
    description:
      "Enter each collaborator's wallet address, then use 'Add collaborator' to add more rows.",
    targetElement: ".btn-add",
    position: "bottom",
    page: "initialize",
  },
  {
    id: "confirm-shares",
    title: "Confirm Share Allocation",
    description:
      "The share calculator tracks your total allocation — it must equal 100% before you can submit.",
    targetElement: ".share-calculator",
    position: "left",
    page: "initialize",
  },
  {
    id: "distribute",
    title: "Distribute Funds",
    description:
      "Once initialized, head to Distribute to send royalty payouts to your collaborators.",
    targetElement: '[data-tour-id="distribute"]',
    position: "bottom",
    page: "distribute",
  },
];

const STORAGE_KEY = "srs_onboarding_completed";

interface OnboardingWalkthroughProps {
  onComplete?: () => void;
  /** Current App page, used to auto-navigate as the tour advances across pages. */
  currentPage?: string;
  /** Navigate the host app to a different page (e.g. App's handlePageChange). */
  onPageChange?: (page: string) => void;
  /** Bump this number (e.g. from a "Start Tour" button) to force the tour open from step 1. */
  restartSignal?: number;
}

export const OnboardingWalkthrough: React.FC<OnboardingWalkthroughProps> = ({
  onComplete,
  currentPage,
  onPageChange,
  restartSignal,
}) => {
  const [currentStep, setCurrentStep] = useState(0);
  const [isVisible, setIsVisible] = useState(false);
  const [position, setPosition] = useState<{
    top: number;
    left: number;
    centered: boolean;
  }>({
    top: 0,
    left: 0,
    centered: false,
  });

  useEffect(() => {
    const completed = localStorage.getItem(STORAGE_KEY);
    if (!completed) {
      setIsVisible(true);
    }
  }, []);

  // Restart the tour on demand (e.g. "Start Tour" button in Navigation),
  // regardless of prior completion state.
  useEffect(() => {
    if (restartSignal === undefined || restartSignal === 0) return;
    setCurrentStep(0);
    setIsVisible(true);
  }, [restartSignal]);

  // Navigate the host app to the page a step's target lives on before we
  // try to measure that target's position.
  useEffect(() => {
    if (!isVisible) return;
    const step = STEPS[currentStep];
    if (step.page && step.page !== currentPage) {
      onPageChange?.(step.page);
    }
  }, [isVisible, currentStep, currentPage, onPageChange]);

  useEffect(() => {
    if (!isVisible) return;

    const step = STEPS[currentStep];
    if (step.page && step.page !== currentPage) {
      // Still waiting for the page navigation above to take effect.
      return;
    }

    const targetElement = document.querySelector(step.targetElement);

    if (!targetElement) {
      setPosition({ top: 0, left: 0, centered: true });
      return;
    }

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

    setPosition({ top, left, centered: false });
  }, [isVisible, currentStep, currentPage]);

  function nextStep() {
    if (currentStep < STEPS.length - 1) {
      setCurrentStep(currentStep + 1);
    } else {
      completeWalkthrough();
    }
  }

  function previousStep() {
    if (currentStep > 0) {
      setCurrentStep(currentStep - 1);
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
  const isFirstStep = currentStep === 0;
  const isLastStep = currentStep === STEPS.length - 1;

  return (
    <>
      <div className="onboarding-overlay" onClick={skipWalkthrough} />
      <div
        className={`onboarding-tooltip ${position.centered ? "onboarding-tooltip--centered" : ""}`}
        style={
          position.centered
            ? undefined
            : {
                top: `${position.top}px`,
                left: `${position.left}px`,
              }
        }
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
          {!isFirstStep && (
            <button
              className="onboarding-btn-previous"
              onClick={previousStep}
              type="button"
            >
              Previous
            </button>
          )}
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
