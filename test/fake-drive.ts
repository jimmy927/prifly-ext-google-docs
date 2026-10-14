/** A fake Google for the tests: a FakeProvider answering the Drive and Docs calls the extension makes. */

import { SCOPES } from "../connection";
import type { FakeAccount, FakeProvider } from "./fake-api";

export const DOC_ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz";
export const ACCOUNT: FakeAccount = {
  id: "g1",
  provider: "google",
  account: "maryam@example.com",
  scopes: [...SCOPES],
};

type Failure = { status: number; retryAfter?: string; message?: string };

export type DriveData = {
  files?: unknown[];
  nextPageToken?: string;
  /** The pages `files.list` answers in turn when counting (each the `files` of a page). */
  countPages?: unknown[][];
  markdown?: string;
  commentPages?: { comments: unknown[]; nextPageToken?: string }[];
  /** What `comments.get` answers. */
  comment?: Record<string, unknown>;
  /** What the Doc's metadata answers besides the defaults (name, webViewLink). */
  info?: Record<string, unknown>;
  /** What `documents.get` answers, in turn; the last one stays. */
  documents?: unknown[];
  /** `documents.batchUpdate` answers 400 "revision" when true. */
  conflict?: boolean;
  /** Statuses to answer with first, one per request, before the real answers. */
  failWith?: Failure[];
  /** Answer everything with this status, e.g. 404. */
  always?: number;
};

/** A request the fake was sent, its body read. */
export type Sent = { method: string; url: URL; body: string; contentType: string | null };

function failure(next: Failure | undefined, always: number | undefined): Response | null {
  const status = next?.status ?? always;
  if (status === undefined) return null;
  const headers: Record<string, string> =
    next?.retryAfter === undefined ? {} : { "Retry-After": next.retryAfter };
  return Response.json({ error: { message: next?.message ?? "nope" } }, { status, headers });
}

function docsAnswer(data: DriveData, sent: Sent, documents: unknown[]): Response {
  if (sent.url.pathname.endsWith(":batchUpdate")) {
    if (data.conflict === true) {
      return Response.json(
        {
          error: {
            message: "The required revision ID 'rev-1' does not match the latest revision.",
          },
        },
        { status: 400 },
      );
    }
    return Response.json({ documentId: DOC_ID, writeControl: { requiredRevisionId: "rev-after" } });
  }
  const document = documents.length > 1 ? documents.shift() : documents[0];
  return Response.json(document ?? {});
}

/** `files.list`: the counting pages in turn when counting, else `files`. */
function listAnswer(data: DriveData, sent: Sent, state: State): Response {
  if (sent.url.searchParams.get("fields") === "files(id),nextPageToken" && data.countPages) {
    const page = state.countPages.shift() ?? [];
    const more = state.countPages.length > 0 ? { nextPageToken: "more" } : {};
    return Response.json({ files: page, ...more });
  }
  return Response.json({ files: data.files ?? [], nextPageToken: data.nextPageToken });
}

function driveAnswer(data: DriveData, sent: Sent, state: State): Response {
  const path = sent.url.pathname;
  if (path.startsWith("/upload/drive/v3/files")) {
    return Response.json({
      id: "new-doc-id-12345",
      name: "New",
      webViewLink: "https://docs.google.com/document/d/new-doc-id-12345/edit",
    });
  }
  if (path.endsWith("/export")) return new Response(data.markdown ?? "");
  if (path.endsWith("/replies")) return Response.json({ id: "reply-1", content: "ok" });
  if (path.endsWith("/comments"))
    return Response.json(state.commentPages.shift() ?? { comments: [] });
  if (path.includes("/comments/")) {
    return Response.json({
      id: path.split("/").at(-1),
      content: "Please fix",
      author: { displayName: "Maryam" },
      ...data.comment,
    });
  }
  if (path.endsWith("/files")) return listAnswer(data, sent, state);
  return Response.json({
    name: "Plan",
    webViewLink: `https://docs.google.com/document/d/${DOC_ID}/edit`,
    ...data.info,
  });
}

type State = { commentPages: NonNullable<DriveData["commentPages"]>; countPages: unknown[][] };

/** The provider, and every request it was sent with its body. */
export function fakeDrive(data: DriveData = {}): {
  provider: FakeProvider;
  urls: URL[];
  sent: Sent[];
} {
  const urls: URL[] = [];
  const sent: Sent[] = [];
  const failures = [...(data.failWith ?? [])];
  const documents = [...(data.documents ?? [])];
  const state: State = {
    commentPages: [...(data.commentPages ?? [{ comments: [] }])],
    countPages: [...(data.countPages ?? [])],
  };
  const provider: FakeProvider = async (request) => {
    const url = new URL(request.url);
    const each: Sent = {
      method: request.method,
      url,
      body: await request.text(),
      contentType: request.headers.get("Content-Type"),
    };
    urls.push(url);
    sent.push(each);
    const failed = failure(failures.shift(), data.always);
    if (failed !== null) return failed;
    if (url.hostname === "docs.googleapis.com") return docsAnswer(data, each, documents);
    return driveAnswer(data, each, state);
  };
  return { provider, urls, sent };
}

// --- Documents ---------------------------------------------------------

type Para = { text: string; style?: string; list?: string };

/**
 * A `documents.get` answer (with `includeTabsContent`) whose first tab, `t.0`,
 * holds these paragraphs in order from index 1 (after the section break),
 * each `text` ending with its newline; `header` is the text of one header,
 * and `tabs` how many tabs the Doc has.
 */
export function documentOf(
  paragraphs: Para[],
  revisionId = "rev-1",
  extra: { header?: string; tabs?: number } = {},
): unknown {
  const tab = (n: number, body: unknown) => ({
    tabProperties: { tabId: `t.${n}`, index: n },
    documentTab: body,
  });
  const headers =
    extra.header === undefined
      ? {}
      : {
          headers: {
            "kix.h1": {
              content: [{ paragraph: { elements: [{ textRun: { content: extra.header } }] } }],
            },
          },
        };
  const first = { body: { content: bodyContent(paragraphs) }, ...headers };
  const others = Array.from({ length: (extra.tabs ?? 1) - 1 }, (_, n) =>
    tab(n + 1, { body: { content: bodyContent([{ text: "Other tab\n" }]) } }),
  );
  return { documentId: DOC_ID, title: "Plan", revisionId, tabs: [tab(0, first), ...others] };
}

function bodyContent(paragraphs: Para[]): unknown[] {
  let at = 1;
  const content: unknown[] = [{ endIndex: 1, sectionBreak: {} }];
  for (const each of paragraphs) {
    const start = at;
    const end = start + each.text.length;
    content.push({
      startIndex: start,
      endIndex: end,
      paragraph: {
        elements: [{ startIndex: start, endIndex: end, textRun: { content: each.text } }],
        paragraphStyle: { namedStyleType: each.style ?? "NORMAL_TEXT" },
        ...(each.list === undefined ? {} : { bullet: { listId: each.list, nestingLevel: 0 } }),
      },
    });
    at = end;
  }
  return content;
}
