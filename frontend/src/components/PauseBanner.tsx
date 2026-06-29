import { useEffect, useState } from "react";
import type { PauseState } from "../api";

interface Props {
  pauseState: PauseState;
}

/** Formats a seconds count as `HH:MM:SS` (or `MM:SS` under an hour). */
export function formatCountdown(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return hours > 0
    ? `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
    : `${pad(minutes)}:${pad(seconds)}`;
}

/**
 * #504: Banner shown while a contract is paused. Explains why distributions are
 * blocked and, for emergency (collaborator) pauses, counts down to auto-expiry.
 */
export default function PauseBanner({ pauseState }: Props) {
  const [remaining, setRemaining] = useState(pauseState.remainingSeconds);

  useEffect(() => {
    setRemaining(pauseState.remainingSeconds);
  }, [pauseState.remainingSeconds]);

  useEffect(() => {
    if (remaining <= 0) return;
    const id = setInterval(() => {
      setRemaining((r) => (r > 0 ? r - 1 : 0));
    }, 1000);
    return () => clearInterval(id);
  }, [remaining]);

  if (!pauseState.paused) return null;

  const hasCountdown = pauseState.remainingSeconds > 0;

  return (
    <div className="pause-banner" role="alert" data-testid="pause-banner">
      <strong>⏸ Contract paused</strong>
      <p>
        Distributions are disabled while this contract is paused. Any submitted
        transaction would be rejected on-chain.
      </p>
      {hasCountdown ? (
        <p className="pause-banner__countdown" aria-live="polite">
          {remaining > 0 ? (
            <>
              Emergency pause auto-expires in{" "}
              <strong>{formatCountdown(remaining)}</strong>.
            </>
          ) : (
            <>Pause window elapsed — refresh to check the latest state.</>
          )}
        </p>
      ) : (
        <p className="pause-banner__countdown">
          An admin must unpause the contract before distributions can resume.
        </p>
      )}
    </div>
  );
}
