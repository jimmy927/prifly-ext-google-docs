/**
 * What a chosen board row becomes: a Doc read whole (`open`), a session's
 * first prompt (`launch`), the record of which session it became (`launched`),
 * and the setup rows (connect, give Drive access, sign in, open by link,
 * switch account).
 */

import type { Launch, LaunchItem, LaunchItemNote } from "@prifly/extension-api";
import { errorText, ROW } from "./board";
import { askForDrive, connectionState, signInText, stateText } from "./connection";
import {
  type DocInfo,
  type Drive,
  type DriveComment,
  DriveSignInError,
  docInfo,
  exportMarkdown,
  listComments,
  parseDocId,
} from "./drive";
import { capText, extractPictures, type Picture, renderComments, TEXT_CAP } from "./markdown";
import { access, type Runtime } from "./runtime";

type Image = NonNullable<Launch["images"]>[number];

const READ_TIMEOUT_MS = 60_000;
const NAME_LENGTH = 40;

type DocRead = {
  info: DocInfo;
  id: string;
  text: string;
  pictures: Picture[];
  open: DriveComment[];
};

async function readDoc(drive: Drive, id: string): Promise<DocRead> {
  const signal = AbortSignal.timeout(READ_TIMEOUT_MS);
  const [info, markdown, comments] = await Promise.all([
    docInfo(drive, id, signal),
    exportMarkdown(drive, id, signal),
    listComments(drive, id, signal),
  ]);
  const { text, pictures } = extractPictures(markdown);
  return { info, id, text, pictures, open: comments.filter((each) => !each.resolved) };
}

function empty(message: string): Launch {
  return { prompt: "", message };
}

/** A short slug of the title for the session and its worktree. */
export function slug(title: string): string {
  const words = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return words.slice(0, NAME_LENGTH).replace(/-+$/, "") || "doc";
}

function toImage(picture: Picture): Image | null {
  switch (picture.mediaType) {
    case "image/png":
    case "image/jpeg":
    case "image/gif":
    case "image/webp":
      return { mediaType: picture.mediaType, data: picture.data };
    default:
      return null;
  }
}

/** The Markdown for a prompt: whole up to the cap, then the read-on note with the Doc id. */
export function promptBody(text: string, id: string): string {
  if (text.length <= TEXT_CAP) return text;
  return `${capText(text, 0)}\n\nThe Doc's id for google_docs_read is ${id}.`;
}

function promptOf(read: DocRead, input: string): string {
  const { info } = read;
  const parts = [
    `# ${info.name}`,
    info.link,
    `Last edited by ${info.modifiedBy ?? "an unknown editor"} at ${info.modifiedTime ?? "an unknown time"}`,
    promptBody(read.text, read.id),
  ];
  const comments = renderComments(read.open);
  if (comments !== "") parts.push(`## Open comments\n\n${comments}`);
  if (input.trim() !== "") parts.push(`The reader adds: ${input.trim()}`);
  return parts.join("\n\n");
}

async function launchDoc(
  runtime: Runtime,
  id: string,
  input: string,
  key: string,
): Promise<Launch> {
  const { state, drive } = access(runtime);
  if (drive === null) return empty(stateText(state));
  try {
    const read = await readDoc(drive, id);
    runtime.launching.set(key, {
      docId: id,
      title: read.info.name,
      modifiedTime: read.info.modifiedTime,
    });
    const images = read.pictures.map(toImage).filter((each): each is Image => each !== null);
    return {
      prompt: promptOf(read, input),
      name: slug(read.info.name),
      ...(images.length > 0 ? { images } : {}),
    };
  } catch (error) {
    if (error instanceof DriveSignInError) return empty(signInText(error.account));
    return empty(errorText(error));
  }
}

async function switchAccount(runtime: Runtime): Promise<Launch> {
  const all = runtime.api.connections?.list("google") ?? [];
  const current = access(runtime).state;
  const at = all.findIndex((each) => "connection" in current && each.id === current.connection.id);
  const next = all[(at + 1) % Math.max(all.length, 1)];
  if (next === undefined) return empty(stateText({ kind: "none" }));
  runtime.store.state.connection = next.id;
  runtime.store.save();
  runtime.cache.reset();
  return empty(`Now showing the Docs of ${next.account}.`);
}

async function giveAccess(runtime: Runtime): Promise<Launch> {
  const state = connectionState(runtime.api, runtime.store.state.connection);
  if (state.kind === "none" || state.kind === "no-api") return empty(stateText(state));
  const answer = await askForDrive(runtime.api, state.connection);
  if (!answer.ok) return empty(`Drive access was not given: ${answer.message}`);
  runtime.store.state.connection = answer.connection;
  runtime.store.save();
  runtime.cache.error = null;
  runtime.cache.invalidate();
  return empty(`${answer.account} can now be read: your Docs are loading.`);
}

/** The prompt a session starts with for the board row `key`; an empty one for a setup row. */
export async function launch(runtime: Runtime, key: string, input: string): Promise<Launch> {
  switch (key) {
    case ROW.link: {
      const id = parseDocId(input);
      if (id === null) {
        return empty(
          "That is not a link to a Google Doc: paste an address like docs.google.com/document/d/….",
        );
      }
      return await launchDoc(runtime, id, "", key);
    }
    case ROW.switch:
      return await switchAccount(runtime);
    case ROW.grant:
    case ROW.signIn:
      return await giveAccess(runtime);
    case ROW.connect:
      return empty(stateText(access(runtime).state));
    case ROW.error:
      runtime.cache.invalidate();
      return empty("Asking Google again.");
    case ROW.loading:
      return empty("Still loading your Docs…");
    default:
      return await launchDoc(runtime, key, input, key);
  }
}

function noteText(comment: DriveComment): string {
  const lines: string[] = [];
  if (comment.quoted !== null && comment.quoted.trim() !== "") {
    for (const line of comment.quoted.split("\n")) lines.push(`> ${line}`);
    lines.push("");
  }
  lines.push(comment.content);
  for (const reply of comment.replies) lines.push("", `↳ **${reply.author}**: ${reply.content}`);
  return lines.join("\n");
}

function note(comment: DriveComment): LaunchItemNote {
  const result: LaunchItemNote = { by: comment.author, text: noteText(comment) };
  if (comment.createdTime !== null) result.at = comment.createdTime;
  return result;
}

/** A Doc written out whole for the board's preview. */
export async function open(runtime: Runtime, key: string): Promise<LaunchItem> {
  const { state, drive } = access(runtime);
  if (drive === null) return { title: "Google Docs", markdown: stateText(state) };
  try {
    const read = await readDoc(drive, key);
    const people = [read.info.modifiedBy, read.info.owner].filter(
      (each): each is string => each !== null,
    );
    return {
      title: read.info.name,
      url: read.info.link,
      people: [...new Set(people)],
      markdown: read.text,
      files: read.pictures.map((picture, index) => ({
        id: `picture-${index + 1}`,
        name: `picture ${index + 1}`,
        data: `data:${picture.mediaType};base64,${picture.data}`,
      })),
      notes: read.open.map(note),
    };
  } catch (error) {
    const text = error instanceof DriveSignInError ? signInText(error.account) : errorText(error);
    return { title: "This Doc could not be read", markdown: text };
  }
}

/** Remembers which Doc, and which edit of it, the session `sessionId` started from. */
export function launched(runtime: Runtime, key: string, sessionId: string): void {
  const pending = runtime.launching.get(key);
  runtime.launching.delete(key);
  const docId = pending?.docId ?? key;
  const card = runtime.cache.find(docId);
  const title = pending?.title ?? card?.doc.name;
  if (title === undefined) return;
  runtime.store.state.sessions[sessionId] = {
    docId,
    title,
    modifiedTime: pending?.modifiedTime ?? card?.doc.modifiedTime ?? null,
  };
  runtime.store.save();
}
