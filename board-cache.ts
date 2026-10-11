/**
 * What the launch board answers from: the three lists, the open-comment counts
 * of the first cards, and the last searches. `choices` runs per keystroke, so
 * nothing here is awaited by a keystroke except the very first fill, and that
 * only for a moment.
 */

import {
  BOARD_PAGE_SIZE,
  type BoardDoc,
  type BoardList,
  type DocSummary,
  type Drive,
  listBoardDocs,
  listComments,
  searchDocs,
} from "./drive";
import type { TimerHandle, Timers } from "./timers";

export type Column = BoardList | "search";

export type Card = { doc: BoardDoc; column: Column; comments: number | null };

export type CacheDeps = {
  timers: Timers;
  now: () => number;
  /** How long a fill stays fresh. */
  refreshMs: () => number;
  /** Quiet time after the last keystroke before Drive is searched. */
  debounceMs: number;
  /** Comment counts are fetched for this many cards, this many at a time. */
  badgeCards: number;
  parallel: number;
  log: (event: string, fields?: Record<string, string | number | boolean | null>) => void;
};

export const LISTS: BoardList[] = ["starred", "recent", "shared"];
const SEARCHES_KEPT = 10;

/** Runs `work` over `list`, at most `size` at a time. */
export async function inPool<T>(
  list: readonly T[],
  size: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const item = list[next++];
      if (item !== undefined) await work(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, list.length) }, worker));
}

function summaryCard(each: DocSummary): Card {
  const doc: BoardDoc = {
    id: each.id,
    name: each.name,
    modifiedTime: each.modifiedTime,
    editor: each.modifiedBy,
    owner: null,
    sharedBy: null,
    link: each.link,
  };
  return { doc, column: "search", comments: null };
}

export class BoardCache {
  cards: Card[] = [];
  /** The last fill failed with this; the cards of an earlier fill are kept. */
  error: unknown = null;
  /** False until the first fill of the lists has answered. */
  private filled = false;
  private loadedAt: number | null = null;
  private listing: Promise<void> | null = null;
  private badging: Promise<void> = Promise.resolve();
  private readonly searches = new Map<string, Card[]>();
  private pendingQuery: string | null = null;
  private searchTimer: TimerHandle | null = null;
  private readonly abort = new AbortController();
  private generation = 0;

  private readonly deps: CacheDeps;

  constructor(deps: CacheDeps) {
    this.deps = deps;
  }

  get loaded(): boolean {
    return this.filled;
  }

  /** Starts a fill when there is none yet or the last one is old; at most one runs at a time. */
  ensure(drive: Drive): Promise<void> | null {
    if (this.listing !== null) return this.listing;
    const fresh = this.loadedAt !== null && this.deps.now() - this.loadedAt < this.deps.refreshMs();
    if (fresh) return null;
    const listing = this.fill(drive).finally(() => {
      if (this.listing === listing) this.listing = null;
    });
    this.listing = listing;
    return listing;
  }

  /** The next `ensure` fetches again (the cards stay on show until it answers). */
  invalidate(): void {
    this.loadedAt = null;
    this.searches.clear();
  }

  /** Forgets everything: another account's Docs must not show. */
  reset(): void {
    this.generation++;
    this.listing = null;
    this.cancelSearch();
    this.cards = [];
    this.filled = false;
    this.error = null;
    this.invalidate();
  }

  /** The list fill and the comment counts after it have both finished. */
  async settled(): Promise<void> {
    await this.listing;
    await this.badging;
  }

  find(id: string): Card | undefined {
    const own = this.cards.find((each) => each.doc.id === id);
    if (own !== undefined) return own;
    for (const found of this.searches.values()) {
      const card = found.find((each) => each.doc.id === id);
      if (card !== undefined) return card;
    }
    return undefined;
  }

  /** The cards a finished search for `query` found, if it ran. */
  searched(query: string): Card[] | undefined {
    return this.searches.get(query.trim().toLowerCase());
  }

  /** Searches Drive for `query` once the reader has been quiet for the debounce time. */
  scheduleSearch(query: string, drive: Drive): void {
    const key = query.trim().toLowerCase();
    if (key === "" || this.searches.has(key) || key === this.pendingQuery) return;
    this.cancelSearch();
    this.pendingQuery = key;
    this.searchTimer = this.deps.timers.set(
      () => void this.search(key, drive),
      this.deps.debounceMs,
    );
  }

  /** Cancels a search not yet started (the reader typed on, or the field is empty). */
  cancelSearch(): void {
    if (this.searchTimer !== null) this.deps.timers.clear(this.searchTimer);
    this.searchTimer = null;
    this.pendingQuery = null;
  }

  stop(): void {
    this.cancelSearch();
    this.abort.abort();
  }

  private async search(key: string, drive: Drive): Promise<void> {
    this.searchTimer = null;
    const generation = this.generation;
    let cards: Card[] = [];
    try {
      const found = await searchDocs(drive, key, BOARD_PAGE_SIZE, this.abort.signal);
      cards = found.docs.map(summaryCard);
    } catch (error) {
      this.deps.log("search-failed", { message: error instanceof Error ? error.message : "?" });
    }
    if (generation !== this.generation) return;
    if (this.pendingQuery === key) this.pendingQuery = null;
    this.searches.set(key, cards);
    for (const oldest of [...this.searches.keys()].slice(0, -SEARCHES_KEPT)) {
      this.searches.delete(oldest);
    }
  }

  private async fill(drive: Drive): Promise<void> {
    const generation = this.generation;
    try {
      const lists = await Promise.all(
        LISTS.map((list) => listBoardDocs(drive, list, this.abort.signal)),
      );
      if (generation !== this.generation) return;
      this.cards = this.merge(lists);
      this.error = null;
      this.filled = true;
    } catch (error) {
      if (generation !== this.generation) return;
      this.error = error;
    }
    this.loadedAt = this.deps.now();
    if (this.error === null) this.badging = this.countComments(drive);
  }

  /** A Doc in several lists appears once, in the first of Starred, Recent, Shared. */
  private merge(lists: BoardDoc[][]): Card[] {
    const before = new Map(this.cards.map((each) => [each.doc.id, each.comments]));
    const seen = new Set<string>();
    const cards: Card[] = [];
    LISTS.forEach((column, index) => {
      for (const doc of lists[index] ?? []) {
        if (seen.has(doc.id)) continue;
        seen.add(doc.id);
        cards.push({ doc, column, comments: before.get(doc.id) ?? null });
      }
    });
    return cards;
  }

  private async countComments(drive: Drive): Promise<void> {
    const first = this.cards.slice(0, this.deps.badgeCards);
    await inPool(first, this.deps.parallel, async (card) => {
      try {
        const all = await listComments(drive, card.doc.id, this.abort.signal);
        card.comments = all.filter((each) => !each.resolved).length;
      } catch {
        // A badge is a nicety: the card shows without it.
      }
    });
  }
}
