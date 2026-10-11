/** What the board, the launcher and the watcher share while the extension is active. */

import type { ExtensionApi } from "@prifly/extension-api";
import { BoardCache } from "./board-cache";
import { type ConnectionState, connectionState, driveFor } from "./connection";
import type { Drive } from "./drive";
import { StateStore } from "./state";
import { realTimers, type Timers } from "./timers";

const DEFAULT_REFRESH_SECONDS = 120;

export type Runtime = {
  api: ExtensionApi;
  store: StateStore;
  cache: BoardCache;
  timers: Timers;
  now: () => number;
  /** How long the first `choices` waits for the lists before it says "Loading". */
  firstFillWaitMs: number;
  /** A launch in flight by its board key, until `launched` names its session. */
  launching: Map<string, { docId: string; title: string; modifiedTime: string | null }>;
};

export type RuntimeOptions = {
  timers?: Timers;
  now?: () => number;
  debounceMs?: number;
  firstFillWaitMs?: number;
};

/** The reader's "check every N seconds" in milliseconds. */
export function refreshMs(api: ExtensionApi): number {
  const value = api.settings?.["refreshSeconds"];
  const seconds = typeof value === "number" && value > 0 ? value : DEFAULT_REFRESH_SECONDS;
  return seconds * 1000;
}

export function createRuntime(api: ExtensionApi, options: RuntimeOptions = {}): Runtime {
  const timers = options.timers ?? realTimers();
  const now = options.now ?? Date.now;
  return {
    api,
    store: new StateStore(api),
    timers,
    now,
    firstFillWaitMs: options.firstFillWaitMs ?? 1500,
    launching: new Map(),
    cache: new BoardCache({
      timers,
      now,
      refreshMs: () => refreshMs(api),
      debounceMs: options.debounceMs ?? 400,
      badgeCards: 25,
      parallel: 6,
      log: api.log,
    }),
  };
}

export type Access = { state: ConnectionState; drive: Drive | null };

/** The connection the reader chose (or the first usable one) and a Drive handle when it is ok. */
export function access(runtime: Runtime): Access {
  const state = connectionState(runtime.api, runtime.store.state.connection);
  const drive = state.kind === "ok" ? driveFor(runtime.api, state.connection) : null;
  return { state, drive };
}
