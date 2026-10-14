/**
 * The tools that change a Doc: create one from Markdown, edit one in place,
 * reply to and resolve its comments. Each shows the reader the exact change
 * on a confirm card first, and sends nothing when they cancel.
 */

import type { ExtensionApi, ExtensionTool } from "@prifly/extension-api";
import { ask, DOC_ARG, onDoc, text, withGoogle } from "./common";
import {
  CREATE_URL,
  createDoc,
  createReply,
  type DriveComment,
  docInfo,
  type Google,
  GoogleHttpError,
  getComment,
  replyUrl,
} from "./drive";
import { batchBody, type Operation, parseOperations, planEdit } from "./edit";
import { batchUpdate, batchUpdateUrl, readStructure } from "./structure";

function createTool(api: ExtensionApi): ExtensionTool {
  return {
    name: "google_docs_create",
    description:
      "Create a new Google Doc from Markdown (headings, lists, bold, links, tables), in the account's Drive. The reader confirms it first. Answers the new Doc's id and link. Only for a new Doc: to change an existing one, use google_docs_edit.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "The new Doc's title." },
        markdown: { type: "string", description: "The Doc's content as Markdown." },
      },
      required: ["title", "markdown"],
    },
    call: async (args, ctx) => {
      const title = text(args, "title").trim();
      const markdown = text(args, "markdown");
      if (title === "") return "Not done: a new Doc needs a title.";
      return await withGoogle(api, ctx.signal, null, async (google, signal) => {
        const refused = await ask(api, {
          title: "Create a Google Doc",
          summary: `Create the Google Doc "${title}" in your Drive`,
          details: `Title: ${title}\n\n${markdown}\n\n---\nPOST ${CREATE_URL}\n(Markdown converted to a Google Doc by Drive)`,
        });
        if (refused !== null) return refused;
        const created = await createDoc(google, title, markdown, signal);
        return `Created "${created.name}".\nDoc id: ${created.id}\n${created.link}`;
      });
    },
  };
}

/** What the session is told when the Doc changed since its read: nothing was written. */
export function conflictText(title: string, given: string, current: string | null): string {
  const now = current === null ? "" : `; it is now ${current}`;
  return `Not done: the Doc "${title}" changed since your read (revisionId ${given} is no longer current${now}). Nothing was changed. Call google_docs_read_structure again, rebuild the edit against the new indexes${current === null ? "" : ` and send it with revisionId ${current}`}. Never create a new Doc instead.`;
}

function isRevisionConflict(error: unknown): boolean {
  return (
    error instanceof GoogleHttpError &&
    (error.status === 400 || error.status === 409) &&
    /revision/i.test(error.detail)
  );
}

async function runEdit(
  api: ExtensionApi,
  google: Google,
  id: string,
  revisionId: string,
  ops: Operation[],
  signal: AbortSignal,
): Promise<string> {
  const structure = await readStructure(google, id, signal);
  if (structure.revisionId !== revisionId) {
    return conflictText(structure.title, revisionId, structure.revisionId);
  }
  const plan = planEdit(structure, ops);
  if (typeof plan === "string") return `Not done: ${plan}`;
  const body = batchBody(plan, revisionId);
  const refused = await ask(api, {
    title: "Edit a Google Doc",
    summary: `Change "${structure.title}" in place (${ops.length} ${ops.length === 1 ? "change" : "changes"})`,
    details: [
      `Doc: ${structure.title} (${id})`,
      `revisionId: ${revisionId}`,
      "",
      ...plan.lines,
      "",
      "---",
      `POST ${batchUpdateUrl(id)}`,
      JSON.stringify(body, null, 2),
    ].join("\n"),
  });
  if (refused !== null) return refused;
  try {
    const next = await batchUpdate(google, id, body, signal);
    const after = next === null ? "" : ` New revisionId: ${next}.`;
    return `Done: "${structure.title}" changed in place (${ops.length} ${ops.length === 1 ? "change" : "changes"}).${after} Read google_docs_read_structure again before the next edit by index.`;
  } catch (error) {
    if (!isRevisionConflict(error)) throw error;
    const current = await readStructure(google, id, signal).then(
      (fresh) => fresh.revisionId,
      () => null,
    );
    return conflictText(structure.title, revisionId, current);
  }
}

const OPERATIONS_DOC = `Each operation is one of:
- {"type":"replace_text","find":"old","replace":"new","matchCase":true} — every occurrence;
- {"type":"insert","text":"…","after_heading":"Heading text"} — new normal-text paragraph(s) right under that heading; or {"type":"insert","text":"…","index":42} — at that index as is (end text with \\n to make it its own paragraph);
- {"type":"delete_range","startIndex":10,"endIndex":20} — end exclusive;
- {"type":"style","startIndex":10,"endIndex":20,"heading":2,"bold":true,"bullet":true} — heading 0 is normal text; any of heading, bold, bullet.
Every index is the one google_docs_read_structure showed for revisionId: the extension orders the requests so earlier ones do not move later ones.`;

function editTool(api: ExtensionApi): ExtensionTool {
  return {
    name: "google_docs_edit",
    description: `Edit a Google Doc in place, as one documents.batchUpdate held to the revisionId you read: the same Doc changes, and Google's version history keeps the step. Read google_docs_read_structure first and pass its revisionId. The reader confirms the exact change first. If the Doc changed since your read, nothing is written: read the structure again and rebuild the edit. ${OPERATIONS_DOC}`,
    inputSchema: {
      type: "object",
      properties: {
        doc: DOC_ARG,
        revisionId: {
          type: "string",
          description: "The revisionId google_docs_read_structure showed.",
        },
        operations: { type: "array", items: { type: "object" }, description: OPERATIONS_DOC },
      },
      required: ["doc", "revisionId", "operations"],
    },
    call: (args, ctx) => {
      const revisionId = text(args, "revisionId").trim();
      if (revisionId === "") {
        return Promise.resolve(
          "Not done: pass the revisionId from google_docs_read_structure, read right before the edit.",
        );
      }
      const ops = parseOperations(args["operations"]);
      if (typeof ops === "string") return Promise.resolve(`Not done: ${ops}`);
      return onDoc(api, args, ctx.signal, (id, google) =>
        runEdit(api, google, id, revisionId, ops, ctx.signal),
      );
    },
  };
}

function quoteComment(comment: DriveComment): string {
  const lines: string[] = [];
  if (comment.quoted !== null && comment.quoted.trim() !== "")
    lines.push(`On: "${comment.quoted}"`);
  lines.push(`${comment.author} wrote: ${comment.content}`);
  for (const reply of comment.replies) lines.push(`  ${reply.author} replied: ${reply.content}`);
  return lines.join("\n");
}

type ReplyKind = { resolve: boolean };

async function runReply(
  api: ExtensionApi,
  google: Google,
  doc: string,
  commentId: string,
  reply: string,
  how: ReplyKind,
  signal: AbortSignal,
): Promise<string> {
  let found: [Awaited<ReturnType<typeof docInfo>>, DriveComment];
  try {
    found = await Promise.all([
      docInfo(google, doc, signal),
      getComment(google, doc, commentId, signal),
    ]);
  } catch (error) {
    if (error instanceof GoogleHttpError && error.status === 404) {
      return `Not done: no comment ${commentId} on Doc ${doc} that this account can read.`;
    }
    throw error;
  }
  const [info, comment] = found;
  if (how.resolve && comment.resolved) return "That comment is already resolved: nothing to do.";
  const verb = how.resolve ? "Resolve" : "Reply to";
  const refused = await ask(api, {
    title: how.resolve ? "Resolve a comment" : "Reply to a comment",
    summary: `${verb} ${comment.author}'s comment on "${info.name}"`,
    details: [
      `Doc: ${info.name} (${doc})`,
      quoteComment(comment),
      "",
      reply === "" ? "(no reply text)" : `Reply:\n${reply}`,
      "",
      "---",
      `POST ${replyUrl(doc, commentId)}`,
      JSON.stringify(how.resolve ? { content: reply, action: "resolve" } : { content: reply }),
    ].join("\n"),
  });
  if (refused !== null) return refused;
  await createReply(google, doc, commentId, reply, how.resolve, signal);
  return how.resolve
    ? `Resolved ${comment.author}'s comment on "${info.name}".`
    : `Replied to ${comment.author}'s comment on "${info.name}".`;
}

function replyTool(api: ExtensionApi, how: ReplyKind): ExtensionTool {
  const name = how.resolve ? "google_docs_comment_resolve" : "google_docs_comment_reply";
  return {
    name,
    description: how.resolve
      ? "Resolve a comment on a Google Doc, with an optional closing reply. commentId comes from google_docs_comments. The reader confirms it first."
      : "Reply to a comment on a Google Doc. commentId comes from google_docs_comments. The reader confirms the reply first.",
    inputSchema: {
      type: "object",
      properties: {
        doc: DOC_ARG,
        commentId: { type: "string", description: "The comment's id from google_docs_comments." },
        text: {
          type: "string",
          description: how.resolve ? "An optional reply posted with the resolve." : "The reply.",
        },
      },
      required: how.resolve ? ["doc", "commentId"] : ["doc", "commentId", "text"],
    },
    call: (args, ctx) => {
      const commentId = text(args, "commentId").trim();
      const reply = text(args, "text").trim();
      if (commentId === "") return Promise.resolve("Not done: pass the comment's commentId.");
      if (!how.resolve && reply === "") return Promise.resolve("Not done: a reply needs text.");
      return onDoc(api, args, ctx.signal, (id, google) =>
        runReply(api, google, id, commentId, reply, how, ctx.signal),
      );
    },
  };
}

export function writeTools(api: ExtensionApi): ExtensionTool[] {
  return [
    createTool(api),
    editTool(api),
    replyTool(api, { resolve: false }),
    replyTool(api, { resolve: true }),
  ];
}
