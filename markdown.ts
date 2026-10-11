/**
 * A Doc's Markdown made fit for a prompt: pictures pulled out, a size cap, and
 * comments rendered as Markdown. The launcher reuses `extractPictures` and
 * `renderComments`.
 */

import type { DriveComment } from "./drive";

export const MAX_PICTURES = 20;
export const TEXT_CAP = 60_000;

export type Picture = { mediaType: string; data: string };

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

const DATA_URI = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=_-]+)$/i;
// ![alt](data:...) and ![alt][label].
const USE = /!\[[^\]]*\](?:\(<?(data:[^)>\s]+)>?\)|\[([^\]]+)\])/g;
// [label]: <data:...>
const DEFINITION = /^[ \t]*\[([^\]]+)\]:[ \t]*<?(data:[^>\s]+)>?[ \t]*$/gm;

function toPicture(uri: string): Picture | null {
  const match = DATA_URI.exec(uri);
  const mediaType = match?.[1]?.toLowerCase();
  const data = match?.[2];
  if (mediaType === undefined || data === undefined || !IMAGE_TYPES.has(mediaType)) return null;
  return { mediaType, data };
}

/**
 * Replaces each embedded picture (png, jpeg, gif, webp; inline or by a
 * reference definition) with `[picture N]` and returns them in order, at most
 * 20; further ones become `[more pictures not shown]`. Other `data:` URIs stay.
 */
export function extractPictures(markdown: string): { text: string; pictures: Picture[] } {
  const defined = new Map<string, Picture>();
  const withoutDefinitions = markdown.replace(DEFINITION, (line, label: string, uri: string) => {
    const picture = toPicture(uri);
    if (picture === null) return line;
    defined.set(label, picture);
    return "";
  });
  const pictures: Picture[] = [];
  let count = 0;
  const text = withoutDefinitions.replace(USE, (whole, uri: string | undefined, label?: string) => {
    const picture = uri === undefined ? defined.get(label ?? "") : toPicture(uri);
    if (picture === undefined || picture === null) return whole;
    count++;
    if (pictures.length >= MAX_PICTURES) return "[more pictures not shown]";
    pictures.push(picture);
    return `[picture ${count}]`;
  });
  return { text: text.trimEnd(), pictures };
}

/** `text` from character `offset`, at most `cap` of it, with a closing line when cut. */
export function capText(text: string, offset: number, cap = TEXT_CAP): string {
  if (offset >= text.length && text.length > 0) {
    return `Offset ${offset} is past the end of the Doc, which is ${text.length} characters long.`;
  }
  const end = offset + cap;
  if (end >= text.length) return text.slice(offset);
  return `${text.slice(offset, end)}\n\n[Cut here: characters ${offset}–${end} of ${text.length} shown. Call google_docs_read again with offset ${end} to read on.]`;
}

// --- Comments ----------------------------------------------------------

function day(time: string | null): string {
  if (time === null) return "";
  const parsed = new Date(time);
  return Number.isNaN(parsed.getTime()) ? time : parsed.toISOString().slice(0, 10);
}

function byline(author: string, time: string | null, content: string, lead: string): string {
  const when = day(time);
  const [first = "", ...rest] = content.split("\n");
  const head = `${lead}**${author}**${when === "" ? "" : ` · ${when}`}: ${first}`;
  return [head, ...rest.map((line) => `${" ".repeat(lead.length)}${line}`)].join("\n");
}

function renderComment(comment: DriveComment): string {
  const lines: string[] = [];
  if (comment.quoted !== null && comment.quoted.trim() !== "") {
    for (const line of comment.quoted.split("\n")) lines.push(`> ${line}`);
    lines.push("");
  }
  const said = byline(comment.author, comment.createdTime, comment.content, "");
  lines.push(comment.resolved ? `${said} (resolved)` : said);
  for (const reply of comment.replies) {
    lines.push(byline(reply.author, reply.createdTime, reply.content, "  ↳ "));
  }
  return lines.join("\n");
}

/** Open comments (all with `includeResolved`) as Markdown, one block each; "" when there are none. */
export function renderComments(comments: DriveComment[], includeResolved = false): string {
  return comments
    .filter((each) => includeResolved || !each.resolved)
    .map(renderComment)
    .join("\n\n");
}
