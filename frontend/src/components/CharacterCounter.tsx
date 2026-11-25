import React from "react";
import "./CharacterCounter.css";

export interface CharacterCounterProps {
  current: number;
  max: number;
  className?: string;
  testId?: string;
}

export const CharacterCounter: React.FC<CharacterCounterProps> = ({
  current,
  max,
  className = "",
  testId,
}) => {
  const isNearLimit = current >= max * 0.9 && current < max;
  const isAtLimit = current >= max;

  return (
    <div
      className={`character-counter ${isAtLimit ? "at-limit" : isNearLimit ? "near-limit" : ""} ${className}`.trim()}
      data-testid={testId}
      aria-live="polite"
    >
      <span>
        {current}/{max}
      </span>
    </div>
  );
};

export default CharacterCounter;
