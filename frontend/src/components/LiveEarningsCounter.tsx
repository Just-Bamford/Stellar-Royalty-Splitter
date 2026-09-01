import React, { useState, useEffect, useRef, useCallback } from "react";
import { formatCurrency } from "../utils/format";
import "./LiveEarningsCounter.css";

interface LiveEarningsCounterProps {
  value: number;
  currency: string;
  className?: string;
  testId?: string;
}

export const LiveEarningsCounter: React.FC<LiveEarningsCounterProps> = ({
  value,
  currency,
  className = "",
  testId,
}) => {
  const [displayValue, setDisplayValue] = useState(value);
  const [delta, setDelta] = useState<number | null>(null);
  const [isAnimating, setIsAnimating] = useState(false);
  const [lastUpdateTime, setLastUpdateTime] = useState<Date | null>(null);
  const prevValueRef = useRef(value);
  const animationFrameRef = useRef<number>();
  const startTimeRef = useRef<number>();
  const startValueRef = useRef<number>();

  const animateValue = useCallback(
    (from: number, to: number, duration: number = 1500) => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }

      startValueRef.current = from;
      startTimeRef.current = performance.now();
      setIsAnimating(true);

      const animate = (currentTime: number) => {
        if (startTimeRef.current === undefined || startValueRef.current === undefined) return;

        const elapsed = currentTime - startTimeRef.current;
        const progress = Math.min(elapsed / duration, 1);

        // Easing function (ease-out cubic)
        const eased = 1 - Math.pow(1 - progress, 3);

        const currentValue = startValueRef.current + (to - startValueRef.current) * eased;
        setDisplayValue(currentValue);

        if (progress < 1) {
          animationFrameRef.current = requestAnimationFrame(animate);
        } else {
          setIsAnimating(false);
          setDisplayValue(to);
        }
      };

      animationFrameRef.current = requestAnimationFrame(animate);
    },
    []
  );

  useEffect(() => {
    if (value !== prevValueRef.current) {
      const diff = value - prevValueRef.current;
      if (diff > 0) {
        setDelta(diff);
        animateValue(prevValueRef.current, value);
        setLastUpdateTime(new Date());

        // Clear delta badge after 5 seconds
        const timeout = setTimeout(() => {
          setDelta(null);
        }, 5000);

        prevValueRef.current = value;
        return () => clearTimeout(timeout);
      } else {
        // Value decreased (e.g., contract reset), just update without animation
        setDisplayValue(value);
        prevValueRef.current = value;
      }
    }
  }, [value, animateValue]);

  useEffect(() => {
    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, []);

  const formatTimeAgo = (date: Date): string => {
    const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
    if (seconds < 10) return "just now";
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ago`;
  };

  return (
    <div
      className={`live-earnings-counter ${isAnimating ? "animating" : ""} ${className}`}
      data-testid={testId}
      aria-live="polite"
      aria-atomic="true"
    >
      <div className="counter-value-wrapper">
        <span className="counter-value" data-testid={`${testId}-value`}>
          {formatCurrency(displayValue, currency)}
        </span>
        {delta !== null && delta > 0 && (
          <span
            className="delta-badge"
            data-testid={`${testId}-delta`}
            aria-label={`Increased by ${formatCurrency(delta, currency)}`}
          >
            +{formatCurrency(delta, currency)}
          </span>
        )}
      </div>
      {lastUpdateTime && (
        <span className="last-update-time" data-testid={`${testId}-timestamp`}>
          Updated {formatTimeAgo(lastUpdateTime)}
        </span>
      )}
    </div>
  );
};

export default LiveEarningsCounter;
