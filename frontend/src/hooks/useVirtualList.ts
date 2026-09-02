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

  const [totalHeight] = useState(() =>
    typeof itemHeight === "number"
      ? itemCount * itemHeight
      : itemCount * DEFAULT_ITEM_HEIGHT,
  );

  const [scrollTop, setScrollTop] = useState(0);
  const [isScrolling, setIsScrolling] = useState(false);
  const [virtualItems, setVirtualItems] = useState<
    UseVirtualListResult["virtualItems"]
  >([]);
  const [startIndex, setStartIndex] = useState(0);
  const [endIndex, setEndIndex] = useState(Math.min(itemCount, 10));

  const scrollToIndex = useCallback(
    (index: number, _align: "auto" | "top" | "bottom" | "center" = "auto") => {
      if (!container) return;
      const itemH =
        typeof itemHeight === "number" ? itemHeight : DEFAULT_ITEM_HEIGHT;
      const offset = index * itemH;
      container.scrollTop = offset;
      setScrollTop(offset);
    },
    [container, itemHeight],
  );

  const scrollToOffset = useCallback(
    (offset: number) => {
      if (!container) return;
      container.scrollTop = offset;
      setScrollTop(offset);
    },
    [container],
  );

  useEffect(() => {
    if (!container) return;
    const handleScroll = () => {
      setScrollTop(container.scrollTop);
      setIsScrolling(true);
    };
    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => container.removeEventListener("scroll", handleScroll);
  }, [container]);

  useEffect(() => {
    const itemH =
      typeof itemHeight === "number" ? itemHeight : DEFAULT_ITEM_HEIGHT;
    const start = Math.floor(scrollTop / itemH);
    const end = Math.min(
      itemCount,
      start + (container?.clientHeight || 600) / itemH + overscan,
    );

    setStartIndex(start);
    setEndIndex(end);

    const items: UseVirtualListResult["virtualItems"] = [];
    for (let i = start; i < end; i++) {
      items.push({
        index: i,
        start: i * itemH,
        size: itemH,
        offsetTop: i * itemH,
      });
    }
    setVirtualItems(items);
  }, [scrollTop, itemCount, itemHeight, container, overscan]);

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
