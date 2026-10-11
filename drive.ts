/**
 * Google Drive over `api.connections.fetch`: small typed functions that take a
 * `Drive` handle (a connection's fetch) and an AbortSignal. The extension
 * never holds a token.
 */

import type { ExtensionNeedsSignIn } from "@prifly/extension-api";

export type Drive = { fetch(url: string): Promise<Response | ExtensionNeedsSignIn> };

/** Drive answered with a status that is not a success. */
export class DriveHttpError extends Error {
  readonly status: number;
  readonly detail: string;
  constructor(status: number, detail: string) {
    super(`Google answered ${status}${detail === "" ? "" : `: ${detail}`}`);
    this.name = "DriveHttpError";
    this.status = status;
    this.detail = detail;
  }
}

/** Google ended the grant of the connection (a `needsSignIn` answer). */
export class DriveSignInError extends Error {
  readonly account: string;
  constructor(account: string) {
    super(`Google ended the sign-in for ${account}`);
    this.name = "DriveSignInError";
    this.account = account;
  }
}

const API = "https://www.googleapis.com/drive/v3";
const DOC_MIME = "application/vnd.google-apps.document";
const MAX_RETRY_SECONDS = 10;
const MAX_COMMENT_PAGES = 5;

export const MAX_SEARCH_LIMIT = 50;
export const DEFAULT_SEARCH_LIMIT = 20;

export type DocSummary = {
  id: string;
  name: string;
  modifiedTime: string | null;
  modifiedBy: string | null;
  link: string;
};

export type DocInfo = { name: string; link: string; modifiedTime: string | null };

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
  const base = `mimeType='${DOC_MIME}' and trashed=false`;
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
  return `${API}/files?${params}`;
}

function commentsUrl(id: string, pageToken: string | null): string {
  const params = new URLSearchParams({
    includeDeleted: "false",
    pageSize: "100",
    fields:
      "comments(id,content,resolved,createdTime,author/displayName,quotedFileContent/value,replies(content,author/displayName,createdTime)),nextPageToken",
  });
  if (pageToken !== null) params.set("pageToken", pageToken);
  return `${API}/files/${encodeURIComponent(id)}/comments?${params}`;
}

// --- Transport ---------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function field(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function items(value: unknown): unknown[] {
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
    return str(field(field(body, "error"), "message"))?.slice(0, 200) ?? "";
  } catch {
    return "";
  }
}

/** One request; 429 and 503 wait `Retry-After` (at most 10 s) and go once more. */
async function send(drive: Drive, url: string, signal: AbortSignal): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    const answer = await drive.fetch(url);
    if ("needsSignIn" in answer) throw new DriveSignInError(answer.needsSignIn.account);
    if (answer.ok) return answer;
    const busy = answer.status === 429 || answer.status === 503;
    if (!busy || attempt > 0) throw new DriveHttpError(answer.status, await errorDetail(answer));
    await pause(retryAfterMs(answer), signal);
  }
}

async function getJson(drive: Drive, url: string, signal: AbortSignal): Promise<unknown> {
  return await (await send(drive, url, signal)).json();
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
    link: str(field(value, "webViewLink")) ?? `https://docs.google.com/document/d/${id}/edit`,
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

// --- Calls -------------------------------------------------------------

/** Docs whose text or title holds `query` (the recent ones for an empty query). */
export async function searchDocs(
  drive: Drive,
  query: string,
  limit: number,
  signal: AbortSignal,
): Promise<{ docs: DocSummary[]; more: boolean }> {
  const body = await getJson(drive, searchUrl(query, limit), signal);
  const docs = items(field(body, "files"))
    .map(parseDoc)
    .filter((each): each is DocSummary => each !== null);
  return { docs, more: str(field(body, "nextPageToken")) !== null };
}

/** Title, link and last edit of a Doc. */
export async function docInfo(drive: Drive, id: string, signal: AbortSignal): Promise<DocInfo> {
  const params = new URLSearchParams({
    fields: "name,webViewLink,modifiedTime",
    supportsAllDrives: "true",
  });
  const body = await getJson(drive, `${API}/files/${encodeURIComponent(id)}?${params}`, signal);
  return {
    name: str(field(body, "name")) ?? "(untitled)",
    link: str(field(body, "webViewLink")) ?? `https://docs.google.com/document/d/${id}/edit`,
    modifiedTime: str(field(body, "modifiedTime")),
  };
}

/** The Doc exported as Markdown (pictures inline as data: URIs). */
export async function exportMarkdown(
  drive: Drive,
  id: string,
  signal: AbortSignal,
): Promise<string> {
  const url = `${API}/files/${encodeURIComponent(id)}/export?mimeType=text%2Fmarkdown`;
  return await (await send(drive, url, signal)).text();
}

/** Every comment of the Doc, following up to 5 pages. */
export async function listComments(
  drive: Drive,
  id: string,
  signal: AbortSignal,
): Promise<DriveComment[]> {
  const comments: DriveComment[] = [];
  let pageToken: string | null = null;
  for (let page = 0; page < MAX_COMMENT_PAGES; page++) {
    const body = await getJson(drive, commentsUrl(id, pageToken), signal);
    for (const each of items(field(body, "comments"))) {
      const comment = parseComment(each);
      if (comment !== null) comments.push(comment);
    }
    pageToken = str(field(body, "nextPageToken"));
    if (pageToken === null) break;
  }
  return comments;
}
