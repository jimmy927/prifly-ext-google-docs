/** A fake Drive for the tests: a FakeProvider answering the calls the extension makes. */

import { DRIVE_READONLY } from "../connection";
import type { FakeAccount, FakeProvider } from "./fake-api";

export const DOC_ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz";
export const ACCOUNT: FakeAccount = {
  id: "g1",
  provider: "google",
  account: "maryam@example.com",
  scopes: [DRIVE_READONLY],
};

type DriveFailure = { status: number; retryAfter?: string };

export type DriveData = {
  files?: unknown[];
  nextPageToken?: string;
  /** The three board lists and the search answer; each falls back to `files`. */
  starred?: unknown[];
  recent?: unknown[];
  shared?: unknown[];
  searchFiles?: unknown[];
  markdown?: string;
  commentPages?: { comments: unknown[]; nextPageToken?: string }[];
  /** Comments by Doc id; a Doc not named gets the `commentPages`. */
  commentsByDoc?: Record<string, unknown[]>;
  /** What the Doc's metadata answers besides the defaults (name, modifiedTime, ...). */
  info?: Record<string, unknown>;
  /** The changes feed: the start token, then one page per `changes` request. */
  startToken?: string;
  changePages?: { changes: unknown[]; nextPageToken?: string; newStartPageToken?: string }[];
  /** The lists and the comment calls wait for this before answering. */
  gate?: Promise<void>;
  /** Statuses to answer with first, one per request, before the real answers. */
  failWith?: DriveFailure[];
  /** Answer everything with this status, e.g. 404. */
  always?: number;
};

function listAnswer(data: DriveData, url: URL): unknown[] {
  const q = url.searchParams.get("q") ?? "";
  const recent = url.searchParams.get("orderBy")?.startsWith("viewedByMeTime") === true;
  const own = q.includes("fullText")
    ? data.searchFiles
    : q.includes("starred=true")
      ? data.starred
      : q.includes("sharedWithMe=true")
        ? data.shared
        : recent
          ? data.recent
          : undefined;
  return own ?? data.files ?? [];
}

function failure(next: DriveFailure | undefined, always: number | undefined): Response | null {
  const status = next?.status ?? always;
  if (status === undefined) return null;
  const headers: Record<string, string> =
    next?.retryAfter === undefined ? {} : { "Retry-After": next.retryAfter };
  return Response.json({ error: { message: "nope" } }, { status, headers });
}

function commentsAnswer(
  data: DriveData,
  url: URL,
  pages: NonNullable<DriveData["commentPages"]>,
): Response {
  const own = data.commentsByDoc?.[url.pathname.split("/").at(-2) ?? ""];
  if (own !== undefined) return Response.json({ comments: own });
  return Response.json(pages.shift() ?? { comments: [] });
}

/** The provider, the URLs it was asked for, and the most comment calls in flight at once. */
export function fakeDrive(data: DriveData = {}): {
  provider: FakeProvider;
  urls: URL[];
  concurrency: () => number;
} {
  const urls: URL[] = [];
  let inFlight = 0;
  let peak = 0;
  const failures = [...(data.failWith ?? [])];
  const commentPages = [...(data.commentPages ?? [{ comments: [] }])];
  const changePages = [...(data.changePages ?? [])];
  const provider: FakeProvider = async (request) => {
    const url = new URL(request.url);
    urls.push(url);
    const failed = failure(failures.shift(), data.always);
    if (failed !== null) return failed;
    if (url.pathname.endsWith("/export")) return new Response(data.markdown ?? "");
    if (url.pathname.endsWith("/changes/startPageToken")) {
      return Response.json({ startPageToken: data.startToken ?? "start-1" });
    }
    if (url.pathname.endsWith("/changes")) {
      return Response.json(changePages.shift() ?? { changes: [], newStartPageToken: "start-2" });
    }
    if (url.pathname.endsWith("/comments")) {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await data.gate;
      await Bun.sleep(2);
      inFlight--;
      return commentsAnswer(data, url, commentPages);
    }
    if (url.pathname.endsWith("/files")) {
      await data.gate;
      return Response.json({ files: listAnswer(data, url), nextPageToken: data.nextPageToken });
    }
    return Response.json({
      name: "Plan",
      webViewLink: `https://docs.google.com/document/d/${DOC_ID}/edit`,
      ...data.info,
    });
  };
  return { provider, urls, concurrency: () => peak };
}
