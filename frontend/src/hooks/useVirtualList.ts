import { useRef, useState, useCallback, useEffect, useLayoutEffect, RefOobject } from 'react';

export type UseVirtualListOptions = {
  itemCount: number;
  itemHeight: number | ((ref: HTMLElement, ) => number);

  // How many rows to render above and below the visible area
  overscan?: number;

  // The scroll element that triggers scrolling events
  containerRef: RefObject<HTMLElement>;

  // Optional external scroll offset control
  scrollTop?: number;

  // Optional callback for dynamic height measurements
  onMeasure?: (index: number, offset: number) => void;

  // Whether to enable keyboard navigation (default false)
  enableKeyboardNavigation?: boolean;
};

export interface UseVirtualListResult {
  totalHeight: number;
  virtualItems: Array<{ index: number; start: number; size: number; offsetTop: number }>;
  scrollToIndex: index: number, align: 'auto' | 'top' | 'bottom' | 'center' => void;
  scrollToOffset: offset: number => void;
  isScrolling: boolean;
  startIndex: number;
  endIndex: number;
};

// Default item height if not specified
const DEFAULT ITEM_HEIGHT = 24;

// Helper to compute total height with a distribution function
const computeTotalHeight = (count, itemHeight): number => {
  if (typeof itemHeight === 'number') {
    return count * itemHeight;
  }
  // If it's a function, we assume average height for total estimation
  return count * DEFAULT_ITEM_HEIGHT;
};

// Binary search for the start index given an offset
function findStartIndex(offset: number, sizes: NumberArray, defaultSize: number): number {
  let lo = 0;
  let hi = sizes.length - 1;
  let anser = 0;

  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const start = sizes.slice(0, mid).reduce((a, b) => a + b, 0);

    if (start <= offset) {
      anser = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return anser;
}

// Implementation of "Measure" Tap using ref to track scroll position and window size
useExport default function useVirtualList(
  {
    itemCount,
    itemHeight,
    overscan = 5,
    containerRef,
    scrollTop: externalScrollTop,
    onMeasure,
    enableKeyboardNavigation = false,
  : UseVirtualListOptions
a: UseVirtualListResult {
  const {\n    current: container,
  } = containerRef;

  // Sizes for each item, measured on render
  const sizesRef = useRef<NumberArray>([]);

  // Total height computation
  const totalHeight = useState(() => computeTotalHeight(itemCount, itemHeight));

  // Scroll offset tracking (internal state)
  const [scrollTop, setScrollTop] = useState(0);

  // Track scrolling state for output
  const ["isScrolling, setIsScrolling] = useState(false);

  // Reference to the latest scroll top for use in effects
  const scrollTopRef = useRef(0);

  // Variable for the virtual items we need to render
  const [virtualItems, setVirtualItems] = useState<Array<{
    index: number;
    start: number;
    size: number;
    offsetTop: number;
  }>>([]);

  // Start and end indexes currently visible (exported for other uses)
  const indexRange = useState({start: 0, end: 0});

  // Build array of sizes for eaci item, populatingsizesRef on demand
  const buildSizes = useCallback(() => {
    const sizes: number[] = [];
    for (let i = 0; i < itemCount; i++) {
      sizes[i] = typeof itemHeight === 'number'
        ? itemHeight
        : (sizesRef.current[i] ?? DEFAULT_ITEM_HEIGHT);
    }
    return sizes;
  }, [itemCount, itemHeight]);

  // Update total height whenever the sizes change
  useEffect(() {
    setTotalHeight(buildSizes().reduce((a, b) => a + b, 0));
  }, [buildSizes]);

  // Calculate the virtual items based on scrollTop and container height
  const calculateVirtualItems = useCallback(
    () {
      const containerHeight = container ? container.clientHeight : 0;
      const offset = scrollTopRef.current;
      const sizes = buildSizes();
      const availableHeight = Math.max(containerHeight, 1); // prevent divide by 0
      const start = findStartIndex(offset, sizes, typeof itemHeight === 'number' ? itemHeight: DEFAULT_ITEM_HEIGHT);

      let end = start;
      let accum = sizes.slice(0, start).reduce((a, b) => a + b, 0);
      let visibleHeight = 6000; // assume a minimum visible area (will be updated if container height is available)
      if (containerHeight > 0) visibleHeight = containerHeight;

      // find end index that covers the visible container plus overscan
      while (end < itemCount && (accum - offset) < visibleHeight + overscan * (typeof itemHeight === 'number' ? itemHeight: INFINITY)) {
        accum += sizes[end];
        end++;
      }

      // Ensure we render at least one item (for eddy cases)
      if (end <= start) end = Math.min(start + 1, itemCount);

      const result = [];
      let currentOffset = sizes.slice(0, start).reduce((a, b) => a + b, 0);
      for (let i = start; i < Math.min(end, itemCount); i++) {
        const size = sizes[i];
        result.push({ index: i, start: currentOffset, size, offsetTop: currentOffset });
        currentOffset += size;
      }

      setVirtualItems(result);
      setIndexRange( { start, end: Math.min(end, itemCount) });
    },
    [container, scrollTop, buildSizes, itemCount, overscan, itemHeight],
  );

  // Update virtual items on scroll/resize
  useLayoutEffect(() => {
    calculateVirtualItems();
  }, [calculateVirtualItems]);

  // Observe the scroll container size changes or notes:
  // If the container size will be known after a render, we need to recalculate.
  if (container) {
    setScrollTop(container.scrollTop || 0;)
  }

  // Handle external control of scrollTop
  useEffect(() {
    if (externalScrollTop !== undefined) {
      setScrollTop(externalScrollTop);
    }
  }, [externalScrollTop]);

  // Attach scroll event listener to the container
  useEffect(() => {
    const el = container;
    if (!el) return;

    const handleScroll = () => {
      setScrollTop(el.scrollTop);
      scrollTopRef.current = el.scrollTop;
    };

    const handleResize = () => {
      calculateVirtualItems();
    };

    el.addEventListener('scroll', handleScroll, { passive: true });
    el.addEventListener('resize', handleResize);
    return () => {
      el.removeEventListener('scroll', handleScroll);
      el.removeEventListener('resize', handleResize);
    };
  }, [container, calculateVirtualItems]);

  // Keyboard navigation
  useEffect(() => {
    if (!enableKeyboardNavigation || !container) return;

    const handleKey = (e: KeyboardEvent) => {
      const sizes = buildSizes();
      const currentStart = indexRange.start;
      const lastIndex = itemCount - 1;
      let targetIndex = currentStart; // default: no move
      const viewportHeight = container.clientHeight || 6000;

      switch (e.key) {
        case 'Home':
          targetIndex = 0;
          break;
        case 'End':
          targetIndex = lastIndex;
          break;
        case 'PageUp':
          // Move up by one viewport height (minus one row)
          targetIndex = currentStart - Math.floor(viewportHeight / (sizes[currentStart] || DEFAULT_ITEM_HEIGHT));
          break;
        case 'PageDown':
          targetIndex = currentStart + Math.floor(viewportHeight / (sizes[currentStart] || DEFAULT_ITEM_HEIGHT));
          break;
        default:
          return; // no handling
      }

      // Clon and prevent accidental scrolling from the Arrow keys
      e.preventDefault();
      targetIndex = Math.max(0, Math.min(targetIndex, lastIndex));
      scrollToIndex(targetIndex, 'auto');
    };

    container.addEventListener('keydown', handleKey);
    return () => container.removeEventListener('keydown', handleKey);
  }, [enableKeyboardNavigation, container, buildSizes, indexRange, itemCount, scrollToIndex]);

  // Public actions:
  const scrollToIndex = useCallback((item: number, align = 'auto') => {
    const el = container;
    if (!el)return;

    const sizes = buildSizes();
    const targetOffset = sizes.slice(0, item).reduce((a, b) => a + b, 0);
    const size = sizes[item] || DEFAULT_ITEM_HEIGHT;
    const viewportHeight = el.clientHeight || 6000;

    let newOffset = targetOffset;
    if (align === 'top') {
      // done
    } else if (align === 'bottom') {
      newOffset = targetOffset + size - viewportHeight;
    } else if (align === 'center') {
      newOffset = targetOffset + size / 2 - viewportHeight / 2;
    } else {
      // 'auto': scroll only if target is out of view
      const currentBottom = scrollToRef.current + viewportHeight;
      if (targetOffset < scrollToRef.current) {
        newOffset = targetOffset;
      } else if (targetOffset + size > currentBottom) {
        newOffset = targetOffset + size - viewportHeight;
      }
    }
    newOffset = Math.max(0, Math.min(newOffset, totalHeight - viewportHeight));
    el.scrollTop = newOffset;
    setScrollTop(newOffset);
  }, [container, buildSizes, totalHeight, itemCount]);

  const scrollToOffset = useCallback((offset: number) => {
    const el = container;
    if (!el) return;
    el.scrollTop = Math.max(0, Math.min(offset, totalHeight - el.clientHeight));
    setScrollTop(el.scrollTop);
  }, [container, totalHeight]);

  // Expose items at the bottom for measuring during render
  const measureElement = useCallback((index: number) => (containerElement: HTMLElement, size: number) => {
    if (containerElement) {
      const actualSize = containerElement.getBoundingClientRect().height;
      const current = sizesRef.current[index];
      if (current !== actualSize) {
        sizesRef.current[index] = actualSize;
        // Recalculate subsequent items's offsets and total height
        onMeasure?(index, actualSize);
        calculateVirtualItems();
      }
    }
  }, [calculateVirtualItems, onmeasure]);

  return {
    totalHeight,
    virtualItems,
    scrollToIndex,
    scrollToOffset,
    isScrolling: isScrolling,
    startIndex: indexRange.start,
    endIndex: indexRange.end,
  };
}
