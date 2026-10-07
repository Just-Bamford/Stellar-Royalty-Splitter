import { useState, useEffect } from "react";

/**
 * useMediaQuery — reactive CSS media-query matcher.
 *
 * Returns `true` while the given media query matches the viewport and
 * updates on changes. Used to adapt non-CSS-layout concerns (e.g. fixed
 * chart heights, tick density) that media queries alone can't reach,
 * without duplicating breakpoint values in JS by hand (issue #920).
 *
 * Follows the same SSR/defensive pattern as ThemeContext's matchMedia use:
 * guards `window`/`matchMedia` availability, and no-ops to `false` in
 * non-browser environments (jsdom tests, SSR).
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() => {
    if (
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function"
    ) {
      return false;
    }
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    if (
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function"
    ) {
      return;
    }

    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);

    // Sync in case the query result changed between render and effect.
    update();

    if (typeof media.addEventListener === "function") {
      media.addEventListener("change", update);
      return () => media.removeEventListener("change", update);
    }

    // Legacy Safari/older browsers: addListener/removeListener
    media.addListener(update);
    return () => media.removeListener(update);
  }, [query]);

  return matches;
}

export default useMediaQuery;
