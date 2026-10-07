/**
 * Web3Profile — displays human-readable Web3 identity for a wallet address.
 *
 * Shows:
 *  - ENS name (e.g. "alice.eth") with a verified checkmark
 *  - Lens Protocol handle (e.g. "lens/@alice") with follower count
 *  - Avatar from ENS or Lens (falls back to a deterministic color avatar)
 *  - Truncated address as a fallback when no identity resolves
 *
 * The component is deliberately lightweight:
 *  - Fires both ENS + Lens lookups concurrently on mount
 *  - Shows a skeleton while loading
 *  - Never throws — all errors are swallowed in the service layer
 *  - Accepts a `size` prop so it works inline in table rows ("sm") as well
 *    as in larger profile cards ("md" / "lg")
 */

import { useEffect, useState } from "react";
import { resolveIdentity, type Web3Identity } from "../services/web3-identity";
import "./Web3Profile.css";

// ── Props ─────────────────────────────────────────────────────────────────────

export interface Web3ProfileProps {
  /** Full wallet address (Stellar G… or Ethereum 0x…) */
  address: string;
  /** Controls visual footprint. Defaults to "sm" for inline table use. */
  size?: "sm" | "md" | "lg";
  /** When true, renders only the avatar + primary name (no stats row). */
  compact?: boolean;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Truncate an address to 8…6 chars for display. */
function truncate(addr: string): string {
  if (addr.length <= 16) return addr;
  return `${addr.slice(0, 8)}…${addr.slice(-6)}`;
}

/**
 * Generate a deterministic hue from an address string.
 * Used as the fallback avatar background so each address gets a unique colour.
 */
function addressHue(addr: string): number {
  let hash = 0;
  for (let i = 0; i < addr.length; i++) {
    hash = (hash * 31 + addr.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 360;
}

/** Return the best available avatar URL, or null. */
function pickAvatar(identity: Web3Identity): string | null {
  return identity.lens?.picture ?? identity.ens?.avatar ?? null;
}

/** Return the primary display name (ENS takes priority, then Lens handle). */
function primaryName(identity: Web3Identity): string | null {
  return identity.ens?.name ?? identity.lens?.handle ?? null;
}

// ── Avatar sub-component ──────────────────────────────────────────────────────

interface AvatarProps {
  src: string | null;
  address: string;
  size: "sm" | "md" | "lg";
  alt: string;
}

function Avatar({ src, address, size, alt }: AvatarProps) {
  const [imgError, setImgError] = useState(false);
  const hue = addressHue(address);

  const showFallback = !src || imgError;

  return (
    <div
      className={`web3-avatar web3-avatar--${size}`}
      style={
        showFallback
          ? { background: `hsl(${hue}, 60%, 55%)` }
          : undefined
      }
      aria-hidden="true"
    >
      {showFallback ? (
        <span className="web3-avatar__initials">
          {address.slice(0, 2).toUpperCase()}
        </span>
      ) : (
        <img
          src={src!}
          alt={alt}
          className="web3-avatar__img"
          onError={() => setImgError(true)}
        />
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function Web3Profile({
  address,
  size = "sm",
  compact = false,
}: Web3ProfileProps) {
  const [identity, setIdentity] = useState<Web3Identity | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!address) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);

    resolveIdentity(address).then((result) => {
      if (!cancelled) {
        setIdentity(result);
        setLoading(false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [address]);

  // ── Loading skeleton ────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div
        className={`web3-profile web3-profile--${size} web3-profile--loading`}
        aria-busy="true"
        aria-label="Loading identity…"
      >
        <div className={`web3-avatar web3-avatar--${size} web3-skeleton`} />
        <div className="web3-profile__text">
          <div className="web3-skeleton web3-skeleton--name" />
          {!compact && size !== "sm" && (
            <div className="web3-skeleton web3-skeleton--sub" />
          )}
        </div>
      </div>
    );
  }

  // ── No identity resolved ────────────────────────────────────────────────────
  if (!identity) {
    return (
      <span className="web3-profile web3-profile--plain" title={address}>
        {truncate(address)}
      </span>
    );
  }

  const name = primaryName(identity);
  const avatar = pickAvatar(identity);
  const isVerified = identity.ens?.verified ?? false;
  const hasLens = identity.lens !== null;

  // ── sm: inline pill (table rows, chips) ────────────────────────────────────
  if (size === "sm") {
    return (
      <span
        className="web3-profile web3-profile--sm"
        title={address}
        aria-label={name ?? truncate(address)}
      >
        <Avatar src={avatar} address={address} size="sm" alt="" />
        <span className="web3-profile__name">
          {name ?? truncate(address)}
          {isVerified && (
            <span
              className="web3-profile__verified"
              aria-label="ENS verified"
              title="ENS verified"
            >
              ✓
            </span>
          )}
        </span>
        {hasLens && !compact && (
          <span className="web3-profile__lens-badge" aria-label="Lens profile">
            🌿
          </span>
        )}
      </span>
    );
  }

  // ── md / lg: card layout ───────────────────────────────────────────────────
  return (
    <div
      className={`web3-profile web3-profile--${size}`}
      aria-label={`Web3 profile for ${name ?? truncate(address)}`}
    >
      <Avatar src={avatar} address={address} size={size} alt={name ?? truncate(address)} />

      <div className="web3-profile__body">
        {/* Primary name row */}
        <div className="web3-profile__name-row">
          <span className="web3-profile__name">
            {name ?? truncate(address)}
          </span>
          {isVerified && (
            <span
              className="web3-profile__verified"
              aria-label="ENS verified"
              title="Verified via ENS"
            >
              ✓
            </span>
          )}
        </div>

        {/* Address sub-line */}
        <span className="web3-profile__address" title={address}>
          {truncate(address)}
        </span>

        {/* Lens stats */}
        {!compact && identity.lens && (
          <div className="web3-profile__lens-stats">
            <span className="web3-profile__lens-handle">
              🌿 {identity.lens.handle}
            </span>
            <span className="web3-profile__stat">
              <strong>{identity.lens.followers.toLocaleString()}</strong>{" "}
              followers
            </span>
            <span className="web3-profile__stat">
              <strong>{identity.lens.following.toLocaleString()}</strong>{" "}
              following
            </span>
          </div>
        )}

        {/* Bio */}
        {!compact && size === "lg" && identity.lens?.bio && (
          <p className="web3-profile__bio">{identity.lens.bio}</p>
        )}
      </div>
    </div>
  );
}
