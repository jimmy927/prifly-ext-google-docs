/**
 * Google's Drive and Docs APIs over `api.connections.fetch`: small typed
 * functions that take a `Google` handle (a connection's fetch) and an
 * AbortSignal. The extension never holds a token.
 */

import type { ExtensionNeedsSignIn } from "@prifly/extension-api";

/** A connection's fetch: prifly adds the token to each request. */
export type Google = {
  fetch(url: string, init?: RequestInit): Promise<Response | ExtensionNeedsSignIn>;
};

/** Google answered with a status that is not a success. */
export class GoogleHttpError extends Error {
  readonly status: number;
  readonly detail: string;
  constructor(status: number, detail: string) {
    super(`Google answered ${status}${detail === "" ? "" : `: ${detail}`}`);
    this.name = "GoogleHttpError";
    this.status = status;
    this.detail = detail;
  }
}

/** Google ended the grant of the connection (a `needsSignIn` answer). */
export class SignInError extends Error {
  readonly account: string;
  constructor(account: string) {
    super(`Google ended the sign-in for ${account}`);
    this.name = "SignInError";
    this.account = account;
  }
}

export const DRIVE_API = "https://www.googleapis.com/drive/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
export const DOC_MIME_TYPE = "application/vnd.google-apps.document";
const MAX_RETRY_SECONDS = 10;
const MAX_COMMENT_PAGES = 5;
const MAX_COUNT_PAGES = 10;
const COUNT_PAGE_SIZE = 1000;

export const MAX_SEARCH_LIMIT = 50;
export const DEFAULT_SEARCH_LIMIT = 20;

export type DocSummary = {
  id: string;
  name: string;
  modifiedTime: string | null;
  modifiedBy: string | null;
  link: string;
};

export type DocInfo = {
  name: string;
  link: string;
  modifiedTime: string | null;
  modifiedBy: string | null;
  owner: string | null;
};

export type DriveReply = { content: string; author: string; createdTime: string | null };

export type DriveComment = {
  id: string;
  content: string;
  resolved: boolean;
  createdTime: string | null;
  author: string;
  quoted: string | null;
  replies: DriveReply[];
};

/** The link Google gives a Doc it has not said otherwise. */
export function docLink(id: string): string {
  return `https://docs.google.com/document/d/${id}/edit`;
}

// --- Ids ---------------------------------------------------------------

const BARE_ID = /^[A-Za-z0-9_-]{10,}$/;
const DOC_PATH = /^\/document\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]{10,})(?:\/|$)/;

/** The Doc id of a bare id or any docs.google.com/document/d/<id>/... link; null for anything else. */
export function parseDocId(input: string): string | null {
  const trimmed = input.trim();
  if (BARE_ID.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed);
    if (url.hostname !== "docs.google.com") return null;
    return DOC_PATH.exec(url.pathname)?.[1] ?? null;
  } catch {
    return null;
  }
}

// --- Queries -----------------------------------------------------------

function quote(text: string): string {
  return `'${text.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

/** The Drive `q` for Docs: all of them, or those whose text or title holds `query`. */
export function buildSearchQuery(query: string): string {
  const base = `mimeType='${DOC_MIME_TYPE}' and trashed=false`;
  const text = query.trim();
  if (text === "") return base;
  return `${base} and (fullText contains ${quote(text)} or name contains ${quote(text)})`;
}

const LIST_FIELDS =
  "files(id,name,modifiedTime,lastModifyingUser/displayName,owners/displayName,webViewLink),nextPageToken";

export function searchUrl(query: string, limit: number): string {
  const params = new URLSearchParams({
    q: buildSearchQuery(query),
    pageSize: String(Math.min(Math.max(Math.trunc(limit), 1), MAX_SEARCH_LIMIT)),
    includeItemsFromAllDrives: "true",
    supportsAllDrives: "true",
    corpora: "allDrives",
    fields: LIST_FIELDS,
  });
  // Drive refuses orderBy together with fullText.
  if (query.trim() === "") params.set("orderBy", "modifiedTime desc");
  return `${DRIVE_API}/files?${params}`;
}

const COMMENT_FIELDS =
  "id,content,resolved,createdTime,author/displayName,quotedFileContent/value,replies(content,author/displayName,createdTime)";

function commentsUrl(id: string, pageToken: string | null): string {
  const params = new URLSearchParams({
    includeDeleted: "false",
    pageSize: "100",
    fields: `comments(${COMMENT_FIELDS}),nextPageToken`,
  });
  if (pageToken !== null) params.set("pageToken", pageToken);
  return `${DRIVE_API}/files/${encodeURIComponent(id)}/comments?${params}`;
}

// --- Transport ---------------------------------------------------------

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function field(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

export function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function items(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => {
      signal.removeEventListener("abort", aborted);
      resolve();
    };
    const timer = setTimeout(done, ms);
    const aborted = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", aborted, { once: true });
  });
}

function retryAfterMs(response: Response): number {
  const seconds = Number(response.headers.get("Retry-After"));
  if (!Number.isFinite(seconds) || seconds < 0) return 1000;
  return Math.min(seconds, MAX_RETRY_SECONDS) * 1000;
}

async function errorDetail(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    return str(field(field(body, "error"), "message"))?.slice(0, 300) ?? "";
  } catch {
    return "";
  }
}

/**
 * One request. A GET answered 429 or 503 waits `Retry-After` (at most 10 s)
 * and goes once more; a write is never sent twice.
 */
export async function send(
  google: Google,
  url: string,
  signal: AbortSignal,
  init?: RequestInit,
): Promise<Response> {
  const retries = (init?.method ?? "GET").toUpperCase() === "GET";
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    const answer = await google.fetch(url, init);
    if ("needsSignIn" in answer) throw new SignInError(answer.needsSignIn.account);
    if (answer.ok) return answer;
    const busy = answer.status === 429 || answer.status === 503;
    if (!retries || !busy || attempt > 0) {
      throw new GoogleHttpError(answer.status, await errorDetail(answer));
    }
    await pause(retryAfterMs(answer), signal);
  }
}

export async function getJson(google: Google, url: string, signal: AbortSignal): Promise<unknown> {
  return await (await send(google, url, signal)).json();
}

/** A request with a JSON body, answered with JSON. */
export async function sendJson(
  google: Google,
  method: string,
  url: string,
  body: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  const init: RequestInit = {
    method,
    headers: { "Content-Type": "application/json; charset=UTF-8" },
    body: JSON.stringify(body),
  };
  return await (await send(google, url, signal, init)).json();
}

// --- Parsing -----------------------------------------------------------

function parseDoc(value: unknown): DocSummary | null {
  const id = str(field(value, "id"));
  if (id === null) return null;
  return {
    id,
    name: str(field(value, "name")) ?? "(untitled)",
    modifiedTime: str(field(value, "modifiedTime")),
    modifiedBy:
      str(field(field(value, "lastModifyingUser"), "displayName")) ??
      str(field(items(field(value, "owners"))[0], "displayName")),
    link: str(field(value, "webViewLink")) ?? docLink(id),
  };
}

function parseReply(value: unknown): DriveReply {
  return {
    content: str(field(value, "content")) ?? "",
    author: str(field(field(value, "author"), "displayName")) ?? "someone",
    createdTime: str(field(value, "createdTime")),
  };
}

function parseComment(value: unknown): DriveComment | null {
  const id = str(field(value, "id"));
  if (id === null) return null;
  return {
    id,
    content: str(field(value, "content")) ?? "",
    resolved: field(value, "resolved") === true,
    createdTime: str(field(value, "createdTime")),
    author: str(field(field(value, "author"), "displayName")) ?? "someone",
    quoted: str(field(field(value, "quotedFileContent"), "value")),
    replies: items(field(value, "replies")).map(parseReply),
  };
}

// --- Reads -------------------------------------------------------------

/** Docs whose text or title holds `query` (the recent ones for an empty query). */
export async function searchDocs(
  google: Google,
  query: string,
  limit: number,
  signal: AbortSignal,
): Promise<{ docs: DocSummary[]; more: boolean }> {
  const body = await getJson(google, searchUrl(query, limit), signal);
  const docs = items(field(body, "files"))
    .map(parseDoc)
    .filter((each): each is DocSummary => each !== null);
  return { docs, more: str(field(body, "nextPageToken")) !== null };
}

/** Title, link and last edit of a Doc. */
export async function docInfo(google: Google, id: string, signal: AbortSignal): Promise<DocInfo> {
  const params = new URLSearchParams({
    fields: "name,webViewLink,modifiedTime,lastModifyingUser/displayName,owners/displayName",
    supportsAllDrives: "true",
  });
  const url = `${DRIVE_API}/files/${encodeURIComponent(id)}?${params}`;
  const body = await getJson(google, url, signal);
  return {
    name: str(field(body, "name")) ?? "(untitled)",
    link: str(field(body, "webViewLink")) ?? docLink(id),
    modifiedTime: str(field(body, "modifiedTime")),
    modifiedBy: str(field(field(body, "lastModifyingUser"), "displayName")),
    owner: str(field(items(field(body, "owners"))[0], "displayName")),
  };
}

/** The Doc exported as Markdown (pictures inline as data: URIs). */
export async function exportMarkdown(
  google: Google,
  id: string,
  signal: AbortSignal,
): Promise<string> {
  const url = `${DRIVE_API}/files/${encodeURIComponent(id)}/export?mimeType=text%2Fmarkdown`;
  return await (await send(google, url, signal)).text();
}

/** Every comment of the Doc, following up to 5 pages. */
export async function listComments(
  google: Google,
  id: string,
  signal: AbortSignal,
): Promise<DriveComment[]> {
  const comments: DriveComment[] = [];
  let pageToken: string | null = null;
  for (let page = 0; page < MAX_COMMENT_PAGES; page++) {
    const body = await getJson(google, commentsUrl(id, pageToken), signal);
    for (const each of items(field(body, "comments"))) {
      const comment = parseComment(each);
      if (comment !== null) comments.push(comment);
    }
    pageToken = str(field(body, "nextPageToken"));
    if (pageToken === null) break;
  }
  return comments;
}

function commentUrl(doc: string, comment: string): string {
  return `${DRIVE_API}/files/${encodeURIComponent(doc)}/comments/${encodeURIComponent(comment)}`;
}

/** One comment of the Doc. */
export async function getComment(
  google: Google,
  doc: string,
  comment: string,
  signal: AbortSignal,
): Promise<DriveComment> {
  const params = new URLSearchParams({ fields: COMMENT_FIELDS });
  const body = await getJson(google, `${commentUrl(doc, comment)}?${params}`, signal);
  const parsed = parseComment(body);
  if (parsed === null) throw new GoogleHttpError(404, "no such comment");
  return parsed;
}

/** How many Docs the account can see in Drive, and whether there are more than were counted. */
export async function countDocs(
  google: Google,
  signal: AbortSignal,
): Promise<{ count: number; more: boolean }> {
  let count = 0;
  let pageToken: string | null = null;
  for (let page = 0; page < MAX_COUNT_PAGES; page++) {
    const params = new URLSearchParams({
      q: buildSearchQuery(""),
      pageSize: String(COUNT_PAGE_SIZE),
      fields: "files(id),nextPageToken",
    });
    if (pageToken !== null) params.set("pageToken", pageToken);
    const body = await getJson(google, `${DRIVE_API}/files?${params}`, signal);
    count += items(field(body, "files")).length;
    pageToken = str(field(body, "nextPageToken"));
    if (pageToken === null) return { count, more: false };
  }
  return { count, more: true };
}

// --- Writes ------------------------------------------------------------

/** The URL a reply or a resolve is posted to. */
export function replyUrl(doc: string, comment: string): string {
  return `${commentUrl(doc, comment)}/replies?fields=id,content,action`;
}

/** Drive v3 `replies.create`: a reply, or with `resolve` the comment resolved (with an optional reply). */
export async function createReply(
  google: Google,
  doc: string,
  comment: string,
  content: string,
  resolve: boolean,
  signal: AbortSignal,
): Promise<void> {
  const body: Record<string, string> = { content };
  if (resolve) body["action"] = "resolve";
  await sendJson(google, "POST", replyUrl(doc, comment), body, signal);
}

/** The URL a Markdown upload that becomes a Doc goes to. */
export const CREATE_URL = `${UPLOAD_API}/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,webViewLink`;

/** The multipart body of a Markdown upload converted to a Google Doc. */
export function createBody(
  title: string,
  markdown: string,
  boundary: string,
): { body: string; contentType: string } {
  const metadata = JSON.stringify({ name: title, mimeType: DOC_MIME_TYPE });
  const body = [
    `--${boundary}`,
    "Content-Type: application/json; charset=UTF-8",
    "",
    metadata,
    `--${boundary}`,
    "Content-Type: text/markdown; charset=UTF-8",
    "",
    markdown,
    `--${boundary}--`,
    "",
  ].join("\r\n");
  return { body, contentType: `multipart/related; boundary=${boundary}` };
}

/** A new Google Doc from Markdown, converted by Drive on upload. */
export async function createDoc(
  google: Google,
  title: string,
  markdown: string,
  signal: AbortSignal,
): Promise<{ id: string; name: string; link: string }> {
  const { body, contentType } = createBody(title, markdown, `prifly-${crypto.randomUUID()}`);
  const init: RequestInit = { method: "POST", headers: { "Content-Type": contentType }, body };
  const answer: unknown = await (await send(google, CREATE_URL, signal, init)).json();
  const id = str(field(answer, "id"));
  if (id === null) throw new GoogleHttpError(200, "the answer named no Doc id");
  return {
    id,
    name: str(field(answer, "name")) ?? title,
    link: str(field(answer, "webViewLink")) ?? docLink(id),
  };
}
