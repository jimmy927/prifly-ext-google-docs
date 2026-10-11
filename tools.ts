/**
 * The three MCP tools every prifly session can call. Each answers in text and
 * turns a provider answer into one sentence; none of them signs in (that
 * opens a browser behind a session's back).
 */

import type { ExtensionApi, ExtensionTool } from "@prifly/extension-api";
import { connectionState, signInText, stateText } from "./connection";
import {
  DEFAULT_SEARCH_LIMIT,
  type Drive,
  DriveHttpError,
  DriveSignInError,
  docInfo,
  exportMarkdown,
  listComments,
  MAX_SEARCH_LIMIT,
  parseDocId,
  searchDocs,
} from "./drive";
import { capText, extractPictures, renderComments } from "./markdown";

type Args = Record<string, unknown>;
type Run = (drive: Drive, signal: AbortSignal) => Promise<string>;

/** "3 hours ago", "yesterday", "just now". */
export function relativeTime(iso: string | null, now = Date.now()): string {
  const then = iso === null ? Number.NaN : Date.parse(iso);
  if (Number.isNaN(then)) return "at an unknown time";
  const minutes = Math.round((now - then) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "yesterday";
  return days < 60 ? `${days} days ago` : new Date(then).toISOString().slice(0, 10);
}

/** The sentence for a Drive failure the reader can act on; null for anything else. */
export function failure(error: unknown, doc: string | null): string | null {
  if (error instanceof DriveSignInError) return signInText(error.account);
  if (!(error instanceof DriveHttpError)) return null;
  if (error.status === 404 && doc !== null) {
    return `No Doc with id ${doc} that this account can read.`;
  }
  if (error.status === 429 || error.status === 503) {
    return `Google is busy (${error.status}): try again in a minute.`;
  }
  return `${error.message}.`;
}

/** Runs `run` against the Google account, or answers with the sentence for what is in the way. */
async function withDrive(
  api: ExtensionApi,
  signal: AbortSignal,
  doc: string | null,
  run: Run,
): Promise<string> {
  const state = connectionState(api);
  const connections = api.connections;
  if (state.kind !== "ok" || connections === undefined) return stateText(state);
  const drive: Drive = { fetch: (url) => connections.fetch(state.connection.id, url) };
  try {
    return await run(drive, signal);
  } catch (error) {
    const sentence = failure(error, doc);
    if (sentence === null) throw error;
    return sentence;
  }
}

function text(args: Args, key: string): string {
  const value = args[key];
  return typeof value === "string" ? value : "";
}

function whole(args: Args, key: string, fallback: number): number {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;
}

function notADoc(input: string): string {
  return `"${input}" is not a Google Doc id or a docs.google.com/document/d/<id>/… link.`;
}

function searchTool(api: ExtensionApi): ExtensionTool {
  return {
    name: "google_docs_search",
    description:
      "Search the connected Google account's Docs by title or text (an empty query lists the most recently edited). Returns title, Doc id, who edited it and when, and the link.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words to find in a Doc's title or text." },
        limit: {
          type: "number",
          description: `How many Docs at most (default ${DEFAULT_SEARCH_LIMIT}, max ${MAX_SEARCH_LIMIT}).`,
        },
      },
    },
    call: (args, ctx) =>
      withDrive(api, ctx.signal, null, async (drive, signal) => {
        const query = text(args, "query").trim();
        const limit = Math.min(
          Math.max(whole(args, "limit", DEFAULT_SEARCH_LIMIT), 1),
          MAX_SEARCH_LIMIT,
        );
        const { docs, more } = await searchDocs(drive, query, limit, signal);
        if (docs.length === 0) return `No Docs matched "${query}".`;
        const lines = docs.map(
          (doc, index) =>
            `${index + 1}. ${doc.name}\n   Doc id: ${doc.id} · edited by ${doc.modifiedBy ?? "someone"} · ${relativeTime(doc.modifiedTime)}\n   ${doc.link}`,
        );
        if (more) lines.push("More Docs match: narrow the query to see them.");
        return lines.join("\n");
      }),
  };
}

function readTool(api: ExtensionApi): ExtensionTool {
  return {
    name: "google_docs_read",
    description:
      "Read a Google Doc as Markdown, by Doc id or any docs.google.com/document/d/<id>/… link. Long Docs are cut at 60 000 characters: pass offset to read on. Pictures show as [picture N].",
    inputSchema: {
      type: "object",
      properties: {
        doc: { type: "string", description: "A Doc id or a docs.google.com Doc link." },
        offset: { type: "number", description: "Character to start at, to read on in a long Doc." },
      },
      required: ["doc"],
    },
    call: async (args, ctx) => {
      const input = text(args, "doc");
      const id = parseDocId(input);
      if (id === null) return notADoc(input);
      const offset = Math.max(whole(args, "offset", 0), 0);
      return await withDrive(api, ctx.signal, id, async (drive, signal) => {
        const [info, markdown] = await Promise.all([
          docInfo(drive, id, signal),
          exportMarkdown(drive, id, signal),
        ]);
        const { text: body } = extractPictures(markdown);
        return `# ${info.name}\n${info.link}\n\n${capText(body, offset)}`;
      });
    },
  };
}

function commentsTool(api: ExtensionApi): ExtensionTool {
  return {
    name: "google_docs_comments",
    description:
      "The open comments of a Google Doc (by id or link) as Markdown: the quoted text, who said what and when, and the replies. includeResolved adds the resolved ones.",
    inputSchema: {
      type: "object",
      properties: {
        doc: { type: "string", description: "A Doc id or a docs.google.com Doc link." },
        includeResolved: { type: "boolean", description: "Also the resolved comments." },
      },
      required: ["doc"],
    },
    call: async (args, ctx) => {
      const input = text(args, "doc");
      const id = parseDocId(input);
      if (id === null) return notADoc(input);
      const includeResolved = args["includeResolved"] === true;
      return await withDrive(api, ctx.signal, id, async (drive, signal) => {
        const rendered = renderComments(await listComments(drive, id, signal), includeResolved);
        if (rendered === "") return `No ${includeResolved ? "" : "open "}comments on this Doc.`;
        return rendered;
      });
    },
  };
}

export function createTools(api: ExtensionApi): ExtensionTool[] {
  return [searchTool(api), readTool(api), commentsTool(api)];
}

export function registerTools(api: ExtensionApi): void {
  api.tools?.register(createTools(api));
}
