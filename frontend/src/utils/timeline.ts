/**
 * Helpers for the contract activity timeline (#1424).
 *
 * The timeline merges two separately paginated sources (transactions and audit
 * events). Paging each source with the same offset and merging the results
 * makes page 2 of the merged list skip or repeat events, because the sources
 * have different lengths. Instead every source is loaded in full, merged, and
 * paged on the client.
 */

/** The server clamps `limit` to this value, so asking for more silently returns less. */
export const SERVER_MAX_PAGE_SIZE = 100;
/** Safety cap on pages fetched per source (2,000 events with the default page size). */
export const MAX_FETCH_PAGES = 20;

export interface FetchAllResult<T> {
  items: T[];
  /** True when the page cap was reached while the source still had more rows. */
  truncated: boolean;
}

/** Load every page of a source, stopping at the first short page or at `maxPages`. */
export async function fetchAllPages<T>(
  fetchPage: (limit: number, offset: number) => Promise<T[]>,
  pageSize: number = SERVER_MAX_PAGE_SIZE,
  maxPages: number = MAX_FETCH_PAGES,
): Promise<FetchAllResult<T>> {
  const items: T[] = [];
  for (let page = 0; page < maxPages; page += 1) {
    const rows = await fetchPage(pageSize, page * pageSize);
    items.push(...rows);
    if (rows.length < pageSize) return { items, truncated: false };
  }
  return { items, truncated: true };
}

function timeOf(timestamp: string): number {
  const time = new Date(timestamp).getTime();
  return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time;
}

/** Newest first. Events with an unreadable timestamp sort last; ties keep their original order. */
export function sortNewestFirst<T extends { timestamp: string }>(events: T[]): T[] {
  return events
    .map((event, index) => ({ event, index, time: timeOf(event.timestamp) }))
    .sort((a, b) => (b.time === a.time ? a.index - b.index : b.time > a.time ? 1 : -1))
    .map(({ event }) => event);
}

/** One page of `items`. */
export function paginate<T>(items: T[], offset: number, limit: number): T[] {
  return items.slice(Math.max(0, offset), Math.max(0, offset) + limit);
}

/** The largest valid offset for `total` items, so a shrinking list never leaves the user on an empty page. */
export function clampOffset(offset: number, total: number, limit: number): number {
  if (total <= 0) return 0;
  const lastPageOffset = Math.floor((total - 1) / limit) * limit;
  return Math.min(Math.max(0, offset), lastPageOffset);
}

/** The 1-based inclusive range shown on a page, e.g. `{ from: 21, to: 40 }`. */
export function pageRange(
  offset: number,
  limit: number,
  total: number,
): { from: number; to: number } {
  if (total <= 0) return { from: 0, to: 0 };
  return { from: offset + 1, to: Math.min(offset + limit, total) };
}
