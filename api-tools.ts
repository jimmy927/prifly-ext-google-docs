/**
 * The whole Docs, Drive and Sheets APIs for what the curated tools do not cover:
 * `google_docs_api` sends any call to docs.googleapis.com/v1,
 * www.googleapis.com/drive/v3 or sheets.googleapis.com/v4 with the account's auth (anything but a GET
 * is confirmed first), and `google_docs_api_docs` reads Google's own
 * discovery documents, so a changed API is a prompt change.
 */

import type { ExtensionApi, ExtensionTool } from "@prifly/extension-api";
import { ask, cut, googleFor, text } from "./common";
import { signInText } from "./connection";
import { DRIVE_API, field, type Google, isRecord, str } from "./drive";

const RESPONSE_CAP = 60_000;
const DOCS_CAP = 20_000;
const MAX_METHODS = 15;
const MAX_SCHEMAS = 8;
const METHODS = new Set(["GET", "POST", "PATCH", "PUT", "DELETE"]);

/** The hosts and path prefixes the generic tool may reach. */
const ALLOWED = [
  { host: "docs.googleapis.com", prefix: "/v1/" },
  { host: "www.googleapis.com", prefix: "/drive/v3/" },
  { host: "sheets.googleapis.com", prefix: "/v4/" },
];

function withQuery(url: URL, query: unknown): void {
  if (!isRecord(query)) return;
  for (const [key, value] of Object.entries(query)) {
    for (const each of Array.isArray(value) ? value : [value]) {
      if (each === undefined || each === null) continue;
      url.searchParams.append(key, typeof each === "string" ? each : JSON.stringify(each));
    }
  }
}

/** The URL `path` names, when it is on the Docs v1, Drive v3 or Sheets v4 API; otherwise why not. */
export function resolveApiUrl(path: string, query?: unknown): URL | string {
  const trimmed = path.trim();
  const bare = trimmed.replace(/^\/+/, "");
  let url: URL;
  try {
    if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) url = new URL(trimmed);
    else if (bare.startsWith("v1/")) url = new URL(`https://docs.googleapis.com/${bare}`);
    else if (bare.startsWith("drive/v3/")) url = new URL(`https://www.googleapis.com/${bare}`);
    else if (bare.startsWith("v4/")) url = new URL(`https://sheets.googleapis.com/${bare}`);
    else {
      return `Refused: "${path}" is not a Docs, Drive or Sheets API path. Start it with /v1/ (Docs), /drive/v3/ (Drive) or /v4/ (Sheets), or give the whole https URL.`;
    }
  } catch {
    return `Refused: "${path}" is not a URL.`;
  }
  const allowed = ALLOWED.some(
    (each) => url.hostname === each.host && url.pathname.startsWith(each.prefix),
  );
  if (url.protocol !== "https:" || url.port !== "" || url.username !== "" || !allowed) {
    return `Refused: google_docs_api only reaches https://docs.googleapis.com/v1/…, https://www.googleapis.com/drive/v3/… and https://sheets.googleapis.com/v4/…, not ${url.origin}${url.pathname}.`;
  }
  withQuery(url, query);
  return url;
}

function bodyOf(args: Record<string, unknown>): string | null {
  const body = args["body"];
  if (body === undefined || body === null) return null;
  return typeof body === "string" ? body : JSON.stringify(body);
}

/** The id of the Doc, spreadsheet or Drive file a call is about, from its path. */
function fileIdOf(url: URL): string | null {
  const match = /^\/(?:v1\/documents|drive\/v3\/files|v4\/spreadsheets)\/([^/:]+)/.exec(
    url.pathname,
  );
  return match?.[1] === undefined ? null : decodeURIComponent(match[1]);
}

/** The title of the file a call is about, for its summary; null when there is none or it cannot be read. */
async function titleOf(google: Google, url: URL, signal: AbortSignal): Promise<string | null> {
  const id = fileIdOf(url);
  if (id === null) return null;
  const lookup = `${DRIVE_API}/files/${encodeURIComponent(id)}?fields=name&supportsAllDrives=true`;
  try {
    const answer = await google.fetch(lookup, { signal });
    if ("needsSignIn" in answer || !answer.ok) return null;
    return str(field(await answer.json(), "name"));
  } catch {
    return null;
  }
}

/** One plain sentence for what a non-GET call does, naming the file by its title. */
function describeCall(call: ApiCall, name: string | null): string {
  const quoted = name === null ? null : JSON.stringify(name);
  const docs = call.url.hostname === "docs.googleapis.com";
  if (docs && call.method === "POST" && call.url.pathname.endsWith(":batchUpdate")) {
    return `Change ${quoted === null ? "a Google Doc" : `the Google Doc ${quoted}`}.`;
  }
  if (docs && call.method === "POST" && call.url.pathname === "/v1/documents") {
    return "Create a new Google Doc.";
  }
  if (call.url.hostname === "sheets.googleapis.com" && call.method !== "GET") {
    const sheet = describeSheetsCall(call, quoted);
    if (sheet !== null) return sheet;
  }
  const where = docs
    ? "Google Docs"
    : call.url.hostname === "sheets.googleapis.com"
      ? "Google Sheets"
      : "Drive";
  return `Send a ${call.method} request to ${where}${quoted === null ? "" : ` about ${quoted}`}.`;
}

/** The JSON object a call sends, or null when its body is not one. */
function bodyRecord(call: ApiCall): Record<string, unknown> | null {
  if (call.body === null) return null;
  try {
    const parsed: unknown = JSON.parse(call.body);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function rowsIn(values: unknown): number {
  return Array.isArray(values) ? values.length : 0;
}

function plural(n: number, one: string): string {
  return `${n} ${one}${n === 1 ? "" : "s"}`;
}

/** What one `spreadsheets.batchUpdate` request does, in words; null for a kind with no reading. */
function describeSheetRequest(request: unknown): string | null {
  if (!isRecord(request)) return null;
  const title = str(field(field(field(request, "addSheet"), "properties"), "title"));
  if (title !== null) return `add a tab ${JSON.stringify(title)}`;
  if ("updateCells" in request || "appendCells" in request) return "write cells";
  if ("deleteSheet" in request) return "delete a tab";
  if ("deleteDimension" in request || "deleteRange" in request) return "delete cells";
  return null;
}

/** The reading of a `spreadsheets.batchUpdate` body from its requests; null when it has none. */
function describeSheetRequests(body: Record<string, unknown> | null, sheet: string): string | null {
  const requests = body === null ? null : field(body, "requests");
  if (!Array.isArray(requests) || requests.length === 0) return null;
  const parts = requests.map(describeSheetRequest);
  if (parts.some((each) => each === null)) return `Change ${sheet}.`;
  const sentence = [...new Set(parts)].join(" and ");
  const preposition = sentence.startsWith("add") ? "to" : "in";
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)} ${preposition} ${sheet}.`;
}

/**
 * The reading of a call on `values/{range}[:verb]`; null for a verb or method with no reading.
 * A verb is a word of four letters or more after the last colon (a range's own colon is followed
 * by a cell or column, at most three letters), checked after decoding the range.
 */
function describeRangeCall(
  method: string,
  raw: string,
  body: Record<string, unknown> | null,
  sheet: string,
): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  const verb = /:([a-z][A-Za-z]{3,})$/.exec(decoded)?.[1];
  const name = verb === undefined ? decoded : decoded.slice(0, -(verb.length + 1));
  if (verb === "clear") return `Clear ${name} in ${sheet}.`;
  if (verb !== undefined && verb !== "append") return null;
  if (body === null || (verb === undefined && method !== "PUT")) return null;
  const rows = plural(rowsIn(field(body, "values")), "row");
  return verb === "append"
    ? `Append ${rows} after ${name} in ${sheet}.`
    : `Write ${rows} into ${name} in ${sheet}.`;
}

/** One plain sentence for a write to a spreadsheet, or null when the call has no reading of its own. */
function describeSheetsCall(call: ApiCall, quoted: string | null): string | null {
  const sheet = quoted === null ? "a spreadsheet" : `the spreadsheet ${quoted}`;
  const path = call.url.pathname;
  const body = bodyRecord(call);
  if (path.endsWith(":batchUpdate") && !path.includes("/values")) {
    return describeSheetRequests(body, sheet);
  }
  const range = /\/values\/([^/]+)$/.exec(path);
  if (range?.[1] !== undefined) return describeRangeCall(call.method, range[1], body, sheet);
  if (path.endsWith("/values:batchUpdate") && body !== null) {
    const data = field(body, "data");
    if (!Array.isArray(data)) return null;
    const rows = data.reduce((sum: number, each) => sum + rowsIn(field(each, "values")), 0);
    return `Write ${plural(rows, "row")} into ${plural(data.length, "range")} of ${sheet}.`;
  }
  return null;
}

/** The body as `name: value` lines when it is a flat object of plain values; null when it is not readable. */
function readableBody(body: string | null): string | null {
  if (body === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const entries = Object.entries(parsed);
  const plain = entries.every(([, value]) =>
    ["string", "number", "boolean"].includes(typeof value),
  );
  if (entries.length === 0 || !plain) return null;
  return entries.map(([key, value]) => `${key}: ${value}`).join("\n");
}

async function answerText(response: Response): Promise<string> {
  const body = await response.text();
  const head = `${response.status}${response.statusText === "" ? "" : ` ${response.statusText}`}`;
  return `${head}\n\n${cut(body, RESPONSE_CAP)}`;
}

export function apiTool(api: ExtensionApi): ExtensionTool {
  return {
    name: "google_docs_api",
    description:
      "Any call to the Google Docs API (https://docs.googleapis.com/v1/…), the Drive API (https://www.googleapis.com/drive/v3/…) or the Google Sheets API v4 (https://sheets.googleapis.com/v4/…, e.g. add a tab with spreadsheets.batchUpdate, write cells with spreadsheets.values.update) with the connected account, for what the other google_docs_* tools do not cover. A GET runs at once; anything else is shown to the reader on a confirm card first. Look the method up with google_docs_api_docs. Answers the status and the response body.",
    inputSchema: {
      type: "object",
      properties: {
        method: { type: "string", description: "GET (default), POST, PATCH, PUT or DELETE." },
        path: {
          type: "string",
          description:
            "/v1/documents/{id} (Docs), /drive/v3/files/{id} (Drive), /v4/spreadsheets/{id} (Sheets), or the whole https URL.",
        },
        query: { type: "object", description: "Query parameters, by name." },
        body: { type: "object", description: "The JSON request body." },
      },
      required: ["path"],
    },
    call: async (args, ctx) => {
      const call = apiCall(args);
      if (typeof call === "string") return call;
      const found = googleFor(api);
      if ("problem" in found) return found.problem;
      if (call.method !== "GET") {
        const refused = await askAboutCall(api, found.google, call, ctx.signal);
        if (refused !== null) return refused;
      }
      const answer = await found.google.fetch(call.url.href, requestInit(call, ctx.signal));
      if ("needsSignIn" in answer) return signInText(answer.needsSignIn.account);
      return await answerText(answer);
    },
  };
}

type ApiCall = { method: string; url: URL; body: string | null };

/** The confirm card for a write: plain words first, the request under Details. */
async function askAboutCall(
  api: ExtensionApi,
  google: Google,
  call: ApiCall,
  signal: AbortSignal,
): Promise<string | null> {
  const name = await titleOf(google, call.url, signal);
  const content = readableBody(call.body);
  return await ask(api, {
    title: "Call the Google Docs API",
    summary: describeCall(call, name),
    ...(content === null ? {} : { content }),
    details: `${call.method} ${call.url.href}${call.body === null ? "" : `\n\n${call.body}`}`,
  });
}

function requestInit(call: ApiCall, signal: AbortSignal): RequestInit {
  const init: RequestInit = { method: call.method, signal };
  if (call.body !== null) {
    init.body = call.body;
    init.headers = { "Content-Type": "application/json; charset=UTF-8" };
  }
  return init;
}

/** The request a `google_docs_api` call names, or why it is refused. */
function apiCall(args: Record<string, unknown>): ApiCall | string {
  const method = (text(args, "method").trim() || "GET").toUpperCase();
  if (!METHODS.has(method)) return `Refused: ${method} is not one of ${[...METHODS].join(", ")}.`;
  const url = resolveApiUrl(text(args, "path"), args["query"]);
  if (typeof url === "string") return url;
  return { method, url, body: method === "GET" ? null : bodyOf(args) };
}

// --- Discovery ---------------------------------------------------------

export type FetchPublic = (url: string) => Promise<Response>;

export const DISCOVERY: Record<string, string> = {
  docs: "https://docs.googleapis.com/$discovery/rest?version=v1",
  drive: "https://www.googleapis.com/discovery/v1/apis/drive/v3/rest",
  sheets: "https://sheets.googleapis.com/$discovery/rest?version=v4",
};

type Method = {
  id: string;
  httpMethod: string;
  path: string;
  description: string;
  parameters: string[];
  request: string | null;
  response: string | null;
};

function short(value: string, cap: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length <= cap ? flat : `${flat.slice(0, cap - 1)}…`;
}

function parameters(value: unknown): string[] {
  if (!isRecord(value)) return [];
  return Object.entries(value).map(([name, each]) => {
    const where = str(field(each, "location")) ?? "query";
    const type = str(field(each, "type")) ?? "any";
    const required = field(each, "required") === true ? ", required" : "";
    return `${name} (${where}, ${type}${required}) — ${short(str(field(each, "description")) ?? "", 150)}`;
  });
}

function collectMethods(resource: unknown, base: string, out: Method[]): void {
  const methods = field(resource, "methods");
  if (isRecord(methods)) {
    for (const each of Object.values(methods)) {
      out.push({
        id: str(field(each, "id")) ?? "?",
        httpMethod: str(field(each, "httpMethod")) ?? "GET",
        path: `${base}${str(field(each, "flatPath")) ?? str(field(each, "path")) ?? ""}`,
        description: str(field(each, "description")) ?? "",
        parameters: parameters(field(each, "parameters")),
        request: str(field(field(each, "request"), "$ref")),
        response: str(field(field(each, "response"), "$ref")),
      });
    }
  }
  const resources = field(resource, "resources");
  if (isRecord(resources)) {
    for (const each of Object.values(resources)) collectMethods(each, base, out);
  }
}

function matches(haystack: string, words: string[]): boolean {
  const lower = haystack.toLowerCase();
  return words.every((word) => lower.includes(word));
}

function renderMethod(method: Method): string {
  const lines = [`${method.id}  ${method.httpMethod} ${method.path}`];
  if (method.description !== "") lines.push(`  ${short(method.description, 400)}`);
  for (const each of method.parameters) lines.push(`  - ${each}`);
  const io = [
    method.request === null ? null : `request body: ${method.request}`,
    method.response === null ? null : `response: ${method.response}`,
  ].filter((each) => each !== null);
  if (io.length > 0) lines.push(`  ${io.join(" · ")}`);
  return lines.join("\n");
}

function propertyType(value: unknown): string {
  const ref = str(field(value, "$ref"));
  if (ref !== null) return ref;
  const type = str(field(value, "type")) ?? "any";
  return type === "array" ? `array of ${propertyType(field(value, "items"))}` : type;
}

function renderSchema(name: string, schema: unknown): string {
  const lines = [`schema ${name}: ${short(str(field(schema, "description")) ?? "", 300)}`];
  const properties = field(schema, "properties");
  if (isRecord(properties)) {
    for (const [key, each] of Object.entries(properties)) {
      lines.push(
        `  - ${key}: ${propertyType(each)} — ${short(str(field(each, "description")) ?? "", 120)}`,
      );
    }
  }
  return lines.join("\n");
}

/** The methods (and, for a query, the schemas) of a discovery document that match `query`. */
export function searchDiscovery(document: unknown, query: string): string {
  const base = `/${str(field(document, "servicePath")) ?? ""}`;
  const all: Method[] = [];
  collectMethods(document, base, all);
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return cut(
      all.map((each) => `${each.id}  ${each.httpMethod} ${each.path}`).join("\n"),
      DOCS_CAP,
    );
  }
  const found = all.filter((each) => matches(`${each.id} ${each.path} ${each.description}`, words));
  const known = field(document, "schemas");
  const schemas = isRecord(known)
    ? Object.entries(known).filter(([name]) => matches(name, words))
    : [];
  const parts = found.slice(0, MAX_METHODS).map(renderMethod);
  if (found.length > MAX_METHODS) {
    parts.push(`${found.length - MAX_METHODS} more methods match: narrow the query.`);
  }
  parts.push(...schemas.slice(0, MAX_SCHEMAS).map(([name, schema]) => renderSchema(name, schema)));
  if (parts.length === 0) return `Nothing in the API matches "${query}".`;
  return cut(parts.join("\n\n"), DOCS_CAP);
}

export function apiDocsTool(fetchPublic: FetchPublic): ExtensionTool {
  const cache = new Map<string, Promise<unknown>>();
  const load = (api: string): Promise<unknown> => {
    const known = cache.get(api);
    if (known !== undefined) return known;
    const url = DISCOVERY[api] ?? "";
    const loading = fetchPublic(url).then(async (response) => {
      if (!response.ok) throw new Error(`Google answered ${response.status} for ${url}`);
      return (await response.json()) as unknown;
    });
    cache.set(api, loading);
    loading.catch(() => cache.delete(api));
    return loading;
  };
  return {
    name: "google_docs_api_docs",
    description:
      "Look up the Google Docs (v1), Drive (v3) or Sheets (v4) API in Google's own discovery document: the methods matching the query, with HTTP method, path, description and parameters, and the request schemas whose name matches (InsertTextRequest, ParagraphStyle…). An empty query lists every method. For google_docs_api.",
    inputSchema: {
      type: "object",
      properties: {
        api: {
          type: "string",
          enum: ["docs", "drive", "sheets"],
          description: "docs, drive or sheets.",
        },
        query: { type: "string", description: 'Words to find: "batchUpdate", "comments"…' },
      },
      required: ["api"],
    },
    call: async (args) => {
      const api = text(args, "api").trim().toLowerCase();
      if (DISCOVERY[api] === undefined) return 'api is "docs", "drive" or "sheets".';
      try {
        return searchDiscovery(await load(api), text(args, "query"));
      } catch (error) {
        return `Could not read the ${api} discovery document: ${error instanceof Error ? error.message : String(error)}.`;
      }
    },
  };
}
