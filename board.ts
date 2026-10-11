/**
 * The launch board "From a Google Doc…": columns Starred, Recent and Shared
 * with me, answered from the cache on every keystroke, with the setup rows
 * (connect, give Drive access, sign in again, open by link, switch account)
 * for what is in the way.
 */

import type {
  DecorationTone,
  ExtensionConnection,
  LaunchBoard,
  LaunchChoice,
} from "@prifly/extension-api";
import type { Card } from "./board-cache";
import type { ConnectionState } from "./connection";
import { DriveSignInError } from "./drive";
import { type Access, access, type Runtime } from "./runtime";
import { failure, relativeTime } from "./tools";

/** Keys of the rows that are not Docs; a Doc id never holds "!". */
export const ROW = {
  connect: "!connect",
  grant: "!grant",
  signIn: "!signin",
  link: "!link",
  switch: "!switch",
  error: "!error",
  loading: "!loading",
} as const;

const COLUMNS = [
  { id: "starred", name: "Starred" },
  { id: "recent", name: "Recent" },
  { id: "shared", name: "Shared with me" },
];
const SEARCH_COLUMN = { id: "search", name: "Search results" };

function row(key: string, title: string, tone?: DecorationTone): LaunchChoice {
  return tone === undefined ? { key, title } : { key, title, tone };
}

/** The sentence for a Drive failure, or for anything else that went wrong. */
export function errorText(error: unknown): string {
  const known = failure(error, null);
  if (known !== null) return known;
  return error instanceof Error ? error.message : "Google Drive did not answer.";
}

/** The one row a state that is not ok shows. */
function stateRow(state: ConnectionState): LaunchChoice {
  switch (state.kind) {
    case "no-api":
      return row(ROW.connect, "Update prifly to use Google accounts", "warning");
    case "none":
      return row(
        ROW.connect,
        "Connect a Google account in prifly's Vault → Connections",
        "warning",
      );
    case "scope-missing":
      return row(
        ROW.grant,
        `Give prifly read access to your Drive (${state.connection.account})`,
        "warning",
      );
    case "needs-sign-in":
      return signInRow(state.connection.account);
    case "ok":
      return row(ROW.error, "Google Drive is not reachable right now", "critical");
  }
}

function signInRow(account: string): LaunchChoice {
  return row(ROW.signIn, `Sign in again as ${account}`, "warning");
}

function names(card: Card): string[] {
  const all = [card.doc.editor, card.doc.owner].filter((each): each is string => each !== null);
  return [...new Set(all)];
}

function detail(card: Card, now: number): string {
  const when = relativeTime(card.doc.modifiedTime, now);
  const shared = card.column === "shared" ? card.doc.sharedBy : null;
  if (shared !== null) return `Shared by ${shared} · ${when}`;
  const editor = card.doc.editor;
  return editor === null ? `Edited ${when}` : `Edited by ${editor} · ${when}`;
}

function choice(runtime: Runtime, card: Card): LaunchChoice {
  const started = runtime.store.sessionsOf(card.doc.id).length > 0;
  const result: LaunchChoice = {
    key: card.doc.id,
    title: card.doc.name,
    group: card.column,
    detail: detail(card, runtime.now()),
    url: card.doc.link,
    people: names(card),
  };
  if (card.comments !== null && card.comments > 0) result.badges = { comments: card.comments };
  if (started) result.started = true;
  return result;
}

function googleAccounts(runtime: Runtime): ExtensionConnection[] {
  return runtime.api.connections?.list("google") ?? [];
}

/** The cards for what is typed: the cached ones by title, and Drive's search once it answered. */
function visible(runtime: Runtime, query: string, drive: NonNullable<Access["drive"]>): Card[] {
  const { cache } = runtime;
  const text = query.trim().toLowerCase();
  if (text === "") {
    cache.cancelSearch();
    return cache.cards;
  }
  const own = cache.cards.filter((each) => each.doc.name.toLowerCase().includes(text));
  cache.scheduleSearch(text, drive);
  const taken = new Set(own.map((each) => each.doc.id));
  const found = (cache.searched(text) ?? []).filter((each) => !taken.has(each.doc.id));
  return [...own, ...found];
}

async function waitForFirstFill(runtime: Runtime, filling: Promise<void>): Promise<void> {
  const patience = Promise.withResolvers<void>();
  const handle = runtime.timers.set(patience.resolve, runtime.firstFillWaitMs);
  await Promise.race([filling, patience.promise]);
  runtime.timers.clear(handle);
}

/** The setup rows under the board: open by link, switch account, and what went wrong. */
function boardActions(runtime: Runtime, access: Access): LaunchChoice[] {
  const actions: LaunchChoice[] = [
    {
      key: ROW.link,
      title: "Open a Doc by its link…",
      input: {
        title: "Open a Doc by its link",
        placeholder: "https://docs.google.com/document/d/…",
      },
    },
  ];
  if (googleAccounts(runtime).length > 1 && access.state.kind === "ok") {
    actions.push(row(ROW.switch, `${access.state.connection.account} · Switch account…`));
  }
  const failed = runtime.cache.error;
  if (failed instanceof DriveSignInError) actions.push(signInRow(failed.account));
  else if (failed !== null) actions.push(row(ROW.error, errorText(failed), "critical"));
  return actions;
}

/** What the launcher `doc` shows for what is typed. */
export async function choices(
  runtime: Runtime,
  query: string,
): Promise<LaunchChoice[] | LaunchBoard> {
  const current = access(runtime);
  const { drive } = current;
  if (drive === null) return [stateRow(current.state)];
  const { cache } = runtime;
  const filling = cache.ensure(drive);
  if (!cache.loaded && filling !== null) await waitForFirstFill(runtime, filling);
  if (!cache.loaded) {
    const failed = cache.error;
    if (failed instanceof DriveSignInError) return [signInRow(failed.account)];
    if (failed !== null) return [row(ROW.error, errorText(failed), "critical")];
    return [row(ROW.loading, "Loading your Docs…")];
  }
  const cards = visible(runtime, query, drive);
  const searching = cards.some((each) => each.column === "search");
  return {
    columns: searching ? [...COLUMNS, SEARCH_COLUMN] : COLUMNS,
    items: cards.map((each) => choice(runtime, each)),
    actions: boardActions(runtime, current),
  };
}
