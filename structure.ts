/**
 * A Google Doc as the Docs API (v1) holds it, cut down to what an edit needs:
 * the body's paragraphs with their start and end indexes (UTF-16 code units,
 * as Google counts them), their style and list, and the revisionId an edit
 * must name.
 */

import { field, type Google, getJson, items, num, sendJson, str } from "./drive";

export const DOCS_API = "https://docs.googleapis.com/v1";

/** What stands for one index that holds no text: a picture, a page break, a footnote mark. */
export const OBJECT_CHAR = "￼";

export type Paragraph = {
  startIndex: number;
  endIndex: number;
  /** The paragraph's text, its closing newline included; objects as `OBJECT_CHAR`. */
  text: string;
  /** NORMAL_TEXT, TITLE, SUBTITLE, HEADING_1 … HEADING_6. */
  style: string;
  list: { listId: string; level: number } | null;
  /** Where it sits when not in the body's flow: "table r1c2", "table of contents". */
  container: string | null;
};

/** A stretch of the body's text from `start`, each character one index. */
export type Run = { start: number; text: string };

export type Structure = {
  documentId: string;
  title: string;
  revisionId: string;
  paragraphs: Paragraph[];
  runs: Run[];
  /** The body's end index: the last paragraph's closing newline is at `bodyEnd - 1`. */
  bodyEnd: number;
};

/** Thrown when a Docs answer is not the shape the extension reads. */
export class StructureError extends Error {}

function elementText(element: unknown): string {
  const start = num(field(element, "startIndex")) ?? 0;
  const end = num(field(element, "endIndex")) ?? start;
  const run = str(field(field(element, "textRun"), "content"));
  if (run !== null) return run;
  return OBJECT_CHAR.repeat(Math.max(end - start, 0));
}

function parseParagraph(
  element: unknown,
  paragraph: unknown,
  container: string | null,
  runs: Run[],
): Paragraph {
  let text = "";
  for (const each of items(field(paragraph, "elements"))) {
    const piece = elementText(each);
    const start = num(field(each, "startIndex"));
    if (start !== null) runs.push({ start, text: piece });
    text += piece;
  }
  const bullet = field(paragraph, "bullet");
  const listId = str(field(bullet, "listId"));
  return {
    startIndex: num(field(element, "startIndex")) ?? 0,
    endIndex: num(field(element, "endIndex")) ?? 0,
    text,
    style: str(field(field(paragraph, "paragraphStyle"), "namedStyleType")) ?? "NORMAL_TEXT",
    list: listId === null ? null : { listId, level: num(field(bullet, "nestingLevel")) ?? 0 },
    container,
  };
}

function walk(content: unknown[], container: string | null, out: Paragraph[], runs: Run[]): void {
  for (const element of content) {
    const paragraph = field(element, "paragraph");
    if (paragraph !== undefined) {
      out.push(parseParagraph(element, paragraph, container, runs));
      continue;
    }
    const table = field(element, "table");
    if (table !== undefined) {
      items(field(table, "tableRows")).forEach((row, r) => {
        items(field(row, "tableCells")).forEach((cell, c) => {
          walk(items(field(cell, "content")), `table r${r + 1}c${c + 1}`, out, runs);
        });
      });
      continue;
    }
    const toc = field(element, "tableOfContents");
    if (toc !== undefined) walk(items(field(toc, "content")), "table of contents", out, runs);
  }
}

/** The structure of a `documents.get` answer. */
export function parseStructure(document: unknown): Structure {
  const documentId = str(field(document, "documentId"));
  const revisionId = str(field(document, "revisionId"));
  if (documentId === null || revisionId === null) {
    throw new StructureError("Google's answer named no documentId or revisionId");
  }
  const content = items(field(field(document, "body"), "content"));
  const paragraphs: Paragraph[] = [];
  const runs: Run[] = [];
  walk(content, null, paragraphs, runs);
  const last = content.at(-1);
  return {
    documentId,
    title: str(field(document, "title")) ?? "(untitled)",
    revisionId,
    paragraphs,
    runs,
    bodyEnd: num(field(last, "endIndex")) ?? 1,
  };
}

/** The text between two indexes, as it stands in the structure. */
export function textInRange(runs: Run[], start: number, end: number): string {
  let text = "";
  for (const run of runs) {
    const from = Math.max(run.start, start);
    const to = Math.min(run.start + run.text.length, end);
    if (from < to) text += run.text.slice(from - run.start, to - run.start);
  }
  return text;
}

/** HEADING_2 → 2, TITLE → 0 for a heading-like style, null for body text. */
export function headingLevel(style: string): number | null {
  const match = /^HEADING_([1-6])$/.exec(style);
  if (match?.[1] !== undefined) return Number(match[1]);
  return style === "TITLE" || style === "SUBTITLE" ? 0 : null;
}

export function documentUrl(id: string): string {
  return `${DOCS_API}/documents/${encodeURIComponent(id)}`;
}

export function batchUpdateUrl(id: string): string {
  return `${documentUrl(id)}:batchUpdate`;
}

/** `documents.get`: the Doc's first tab, parsed. */
export async function readStructure(
  google: Google,
  id: string,
  signal: AbortSignal,
): Promise<Structure> {
  return parseStructure(await getJson(google, documentUrl(id), signal));
}

/** `documents.batchUpdate`; answers the revisionId the Doc has after it. */
export async function batchUpdate(
  google: Google,
  id: string,
  body: unknown,
  signal: AbortSignal,
): Promise<string | null> {
  const answer = await sendJson(google, "POST", batchUpdateUrl(id), body, signal);
  return str(field(field(answer, "writeControl"), "requiredRevisionId"));
}

// --- Rendering ---------------------------------------------------------

const STRUCTURE_CAP = 60_000;

function describe(paragraph: Paragraph): string {
  const parts = [`${paragraph.startIndex}–${paragraph.endIndex}`, paragraph.style];
  if (paragraph.list !== null) {
    parts.push(`list ${paragraph.list.listId} level ${paragraph.list.level}`);
  }
  if (paragraph.container !== null) parts.push(`in ${paragraph.container}`);
  const shown = paragraph.text.replace(/\n$/, "").replaceAll(OBJECT_CHAR, "[object]");
  return `${parts.join(" · ")} ${JSON.stringify(shown)}`;
}

/** The structure as text for a session, from index `from`, cut at 60 000 characters. */
export function renderStructure(structure: Structure, link: string, from = 0): string {
  const head = [
    `# ${structure.title}`,
    link,
    `Doc id: ${structure.documentId}`,
    `revisionId: ${structure.revisionId}`,
    `Body ends at index ${structure.bodyEnd}. Indexes count UTF-16 code units; each paragraph's text ends with its newline at endIndex - 1, and [object] (a picture or break) takes one index.`,
    "",
    "startIndex–endIndex · style · list · text",
  ].join("\n");
  const lines: string[] = [];
  let size = head.length;
  for (const paragraph of structure.paragraphs) {
    if (paragraph.endIndex <= from) continue;
    const line = describe(paragraph);
    if (size + line.length > STRUCTURE_CAP && lines.length > 0) {
      lines.push(
        `[Cut here: call google_docs_read_structure again with from ${paragraph.startIndex} to read on.]`,
      );
      break;
    }
    lines.push(line);
    size += line.length + 1;
  }
  if (lines.length === 0) lines.push(`No paragraph ends after index ${from}.`);
  return `${head}\n${lines.join("\n")}`;
}
