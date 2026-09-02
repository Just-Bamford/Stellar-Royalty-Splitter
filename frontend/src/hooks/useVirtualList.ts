import { useRef, useState, useCallback, useEffect, RefObject } from "react";

export type UseVirtualListOptions = {
  itemCount: number;
  itemHeight: number | ((ref: HTMLElement) => number);
  overscan?: number;
  containerRef: RefObject<HTMLElement>;
  scrollTop?: number;
  onMeasure?: (index: number, offset: number) => void;
  enableKeyboardNavigation?: boolean;
};

export interface UseVirtualListResult {
  totalHeight: number;
  virtualItems: Array<{
    index: number;
    start: number;
    size: number;
    offsetTop: number;
  }>;
  scrollToIndex: (
    index: number,
    align?: "auto" | "top" | "bottom" | "center",
  ) => void;
  scrollToOffset: (offset: number) => void;
  isScrolling: boolean;
  startIndex: number;
  endIndex: number;
}

const DEFAULT_ITEM_HEIGHT = 24;

export default function useVirtualList(
  options: UseVirtualListOptions,
): UseVirtualListResult {
  const {
    itemCount,
    itemHeight,
    overscan = 5,
    containerRef,
    scrollTop: _externalScrollTop,
    onMeasure,
    enableKeyboardNavigation = false,
  } = options;

  const container = containerRef.current;
  const [scrollTop, setScrollTop] = useState(0);
  const [isScrolling, setIsScrolling] = useState(false);

  const totalHeight =
    typeof itemHeight === "number"
      ? itemCount * itemHeight
      : itemCount * DEFAULT_ITEM_HEIGHT;

  const containerHeight = container?.clientHeight ?? 0;

  const startIndex = Math.max(
    0,
    Math.floor(scrollTop / DEFAULT_ITEM_HEIGHT) - overscan,
  );
  const endIndex = Math.min(
    itemCount,
    Math.ceil((scrollTop + containerHeight) / DEFAULT_ITEM_HEIGHT) + overscan,
  );

  const virtualItems = Array.from({
    length: Math.max(0, endIndex - startIndex),
  }).map((_, i) => {
    const index = startIndex + i;
    return {
      index,
      start: index * DEFAULT_ITEM_HEIGHT,
      size: DEFAULT_ITEM_HEIGHT,
      offsetTop: index * DEFAULT_ITEM_HEIGHT,
    };
  });

  const scrollToIndex = useCallback(
    (index: number, align: "auto" | "top" | "bottom" | "center" = "auto") => {
      if (!container) return;
      const offset = index * DEFAULT_ITEM_HEIGHT;
      container.scrollTop = offset;
    },
    [container],
  );

  const scrollToOffset = useCallback(
    (offset: number) => {
      if (!container) return;
      container.scrollTop = offset;
    },
    [container],
  );

  useEffect(() => {
    if (!container) return;

    const handleScroll = () => {
      setScrollTop(container.scrollTop);
      setIsScrolling(true);
    };

    const handleScrollEnd = () => {
      setIsScrolling(false);
    };

    container.addEventListener("scroll", handleScroll);
    const scrollEndTimer = setTimeout(handleScrollEnd, 150);

    return () => {
      container.removeEventListener("scroll", handleScroll);
      clearTimeout(scrollEndTimer);
    };
  }, [container]);

  return {
    totalHeight,
    virtualItems,
    scrollToIndex,
    scrollToOffset,
    isScrolling,
    startIndex,
    endIndex,
  };
}
