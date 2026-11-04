/**
 * `google_docs_edit`'s operations run on a copy of the structure, for the
 * confirm card: the Doc as it will read afterwards, each paragraph's text
 * marked added or removed, and a note where a paragraph's format changes.
 * Pure: no request here, and it assumes `planEdit` accepted the operations.
 *
 * It follows what Google does with the planned batch: styles first, on the
 * paragraphs the structure shows; inserts and deletes at the structure's
 * indexes; replace_text last, over the text as it then stands. A newline
 * inserted into a paragraph splits it, and both halves keep its style and
 * list, as Google keeps them.
 */

import type { InsertOp, Operation, ReplaceOp, StyleOp } from "./edit";
import { headingLevel, OBJECT_CHAR, type Paragraph, type Structure } from "./structure";

/**
 * The card's redline, as prifly's `ConfirmSpec.doc` takes it ("confirm-doc"
 * in `api.features`). Here until @prifly/extension-api ships the type.
 */
export type ConfirmDoc = { counts: string; blocks: ConfirmDocBlock[] };
export type ConfirmDocBlock = ConfirmDocParagraph | { unchanged: ConfirmDocParagraph[] };
export type ConfirmDocParagraph = {
  style: "title" | "subtitle" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "normal";
  bullet?: boolean;
  spans: ConfirmDocSpan[];
  change?: "added" | "removed";
  note?: string;
};
export type ConfirmDocSpan = { text: string; mark?: "added" | "removed" };

type Format = { style: string; bullet: boolean };

/** One character of the Doc afterwards; a newline also carries the format of the paragraph it ends. */
type Token = {
  ch: string;
  added: boolean;
  removed: boolean;
  format?: Format;
  /** A newline the structure has: the format its paragraph had before the edit. */
  before?: Format;
  /** Set bold, or not bold, on this character. */
  bold?: boolean;
};

/** A paragraph afterwards: its characters and the newline that ends it. */
type Line = { tokens: Token[]; end: Token };

function formatOf(paragraph: Paragraph): Format {
  return { style: paragraph.style, bullet: paragraph.list !== null };
}

/** The paragraphs' formats once the style operations ran, by paragraph. */
function styled(structure: Structure, ops: Operation[]): Format[] {
  const formats = structure.paragraphs.map(formatOf);
  for (const op of ops) {
    if (op.type !== "style") continue;
    structure.paragraphs.forEach((each, i) => {
      const format = formats[i];
      if (format !== undefined && each.startIndex < op.endIndex && each.endIndex > op.startIndex) {
        restyle(format, op);
      }
    });
  }
  return formats;
}

function restyle(format: Format, op: StyleOp): void {
  if (op.heading !== null) {
    format.style = op.heading === 0 ? "NORMAL_TEXT" : `HEADING_${op.heading}`;
  }
  if (op.bullet !== null) format.bullet = op.bullet;
}

/** One character each, as Google counts indexes: UTF-16 code units. */
function units(text: string): string[] {
  return text.split("");
}

function paragraphAt(structure: Structure, index: number): number {
  return structure.paragraphs.findIndex(
    (each) => each.startIndex <= index && index < each.endIndex,
  );
}

function heading(structure: Structure, wanted: string): Paragraph | undefined {
  const name = wanted.trim().toLowerCase();
  return structure.paragraphs.find(
    (each) => headingLevel(each.style) !== null && each.text.trim().toLowerCase() === name,
  );
}

/** The inserts as added tokens, by the index they go in front of, in the order given. */
function insertsByIndex(structure: Structure, ops: Operation[], formats: Format[]) {
  const at = new Map<number, Token[]>();
  /** Headings an insert goes under: their own newline turns normal text. */
  const underHeading = new Set<number>();
  const formatAt = (index: number): Format => {
    const format = formats[paragraphAt(structure, index)];
    return format === undefined ? { style: "NORMAL_TEXT", bullet: false } : { ...format };
  };
  const add = (index: number, tokens: Token[]) =>
    at.set(index, [...(at.get(index) ?? []), ...tokens]);
  for (const op of ops) {
    if (op.type !== "insert") continue;
    const placed = place(structure, op);
    if (placed === null) continue;
    const under = structure.paragraphs[paragraphAt(structure, placed.index)];
    const own = formatAt(placed.index);
    const normal = { style: "NORMAL_TEXT", bullet: own.bullet };
    add(
      placed.index,
      units(placed.text).map((ch, n) => ({
        ch,
        added: true,
        removed: false,
        ...(ch === "\n"
          ? { format: placed.underHeading && n > 0 ? { ...normal } : { ...own } }
          : {}),
        // Under a heading, the newline that now ends the heading reads as the
        // heading's own, and the heading's old newline as the new text's last.
        ...(placed.underHeading && n === 0 && under !== undefined
          ? { added: false, before: formatOf(under) }
          : {}),
      })),
    );
    if (placed.underHeading) underHeading.add(placed.index);
  }
  return { at, underHeading };
}

/** Where an insert goes and what it adds, as `planInsert` sends it. */
function place(
  structure: Structure,
  op: InsertOp,
): { index: number; text: string; underHeading: boolean } | null {
  if (op.afterHeading === null) return { index: op.index, text: op.text, underHeading: false };
  const found = heading(structure, op.afterHeading);
  if (found === undefined) return null;
  return {
    index: found.endIndex - 1,
    text: `\n${op.text.replace(/\n+$/, "")}`,
    underHeading: true,
  };
}

/** Every character of the Doc afterwards, removed ones kept and marked. */
function tokensAfter(structure: Structure, ops: Operation[]): Token[] {
  const formats = styled(structure, ops);
  const { at, underHeading } = insertsByIndex(structure, ops, formats);
  const chars = new Map<number, string>();
  for (const run of structure.runs) {
    for (const [n, ch] of units(run.text).entries()) chars.set(run.start + n, ch);
  }
  const ends = new Map(structure.paragraphs.map((each, i) => [each.endIndex - 1, i]));
  const tokens: Token[] = [];
  for (let index = 1; index < structure.bodyEnd; index++) {
    tokens.push(...(at.get(index) ?? []));
    const ch = chars.get(index);
    if (ch === undefined) continue;
    const token = original(ch, index, ops);
    const ended = ends.get(index);
    const paragraph = ended === undefined ? undefined : structure.paragraphs[ended];
    if (ch === "\n" && ended !== undefined && paragraph !== undefined) {
      ending(token, paragraph, formats[ended], underHeading.has(index));
    }
    tokens.push(token);
  }
  return tokens;
}

/**
 * A paragraph's own newline: the format it ends with afterwards and the one
 * it had. Under a heading an insert went under, it now ends the inserted text.
 */
function ending(token: Token, paragraph: Paragraph, after: Format | undefined, under: boolean) {
  const format = { ...(after ?? formatOf(paragraph)) };
  token.format = format;
  if (under) {
    format.style = "NORMAL_TEXT";
    token.added = true;
  } else {
    token.before = formatOf(paragraph);
  }
}

/** A character the structure has: deleted or not, and the bold the last style on it sets. */
function original(ch: string, index: number, ops: Operation[]): Token {
  const on = (op: { startIndex: number; endIndex: number }) =>
    op.startIndex <= index && index < op.endIndex;
  const removed = ops.some((op) => op.type === "delete_range" && on(op));
  const bold = ops.findLast(
    (op): op is StyleOp => op.type === "style" && op.bold !== null && on(op),
  )?.bold;
  return { ch, added: false, removed, ...(typeof bold === "boolean" ? { bold } : {}) };
}

function lines(tokens: Token[]): Line[] {
  const out: Line[] = [];
  let current: Token[] = [];
  for (const token of tokens) {
    if (token.ch === "\n" && token.format !== undefined) {
      out.push({ tokens: current, end: token });
      current = [];
    } else {
      current.push(token);
    }
  }
  if (current.length > 0) {
    out.push({
      tokens: current,
      end: {
        ch: "\n",
        added: false,
        removed: false,
        format: { style: "NORMAL_TEXT", bullet: false },
      },
    });
  }
  return out;
}

function count(haystack: string, needle: string): number {
  let found = 0;
  for (
    let at = haystack.indexOf(needle);
    at !== -1;
    at = haystack.indexOf(needle, at + needle.length)
  ) {
    found++;
  }
  return found;
}

/** One replace_text on one paragraph, as Google runs it on the text then standing. */
function replaceIn(line: Line, op: ReplaceOp): void {
  const fold = (text: string) => (op.matchCase ? text : text.toLowerCase());
  const live = line.tokens.flatMap((token, i) => (token.removed ? [] : [i]));
  const text = fold(live.map((i) => line.tokens[i]?.ch ?? "").join(""));
  const needle = fold(op.find);
  const starts: number[] = [];
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length)) {
    starts.push(at);
  }
  for (const start of starts.reverse()) {
    const matched = live.slice(start, start + needle.length);
    const last = matched.at(-1);
    if (last === undefined) continue;
    const replacement = units(op.replace).map((ch) => ({ ch, added: true, removed: false }));
    line.tokens.splice(last + 1, 0, ...replacement);
    for (const i of [...matched].reverse()) {
      const token = line.tokens[i];
      if (token === undefined) continue;
      if (token.added) line.tokens.splice(i, 1);
      else token.removed = true;
    }
  }
}

const STYLES: Record<string, ConfirmDocParagraph["style"]> = {
  TITLE: "title",
  SUBTITLE: "subtitle",
  HEADING_1: "h1",
  HEADING_2: "h2",
  HEADING_3: "h3",
  HEADING_4: "h4",
  HEADING_5: "h5",
  HEADING_6: "h6",
};

function styleName(style: string): string {
  const level = /^HEADING_([1-6])$/.exec(style)?.[1];
  if (level !== undefined) return `Heading ${level}`;
  if (style === "TITLE") return "Title";
  if (style === "SUBTITLE") return "Subtitle";
  return "Normal text";
}

/** What changed in a paragraph's format, "" for nothing. */
function noteOf(line: Line): string {
  const after = line.end.format;
  const before = line.end.before;
  const notes: string[] = [];
  if (after !== undefined && before !== undefined && !line.end.added) {
    if (after.style !== before.style) {
      notes.push(`${styleName(before.style)} → ${styleName(after.style)}`);
    }
    if (after.bullet !== before.bullet) notes.push(after.bullet ? "Bulleted" : "Bullet removed");
  }
  const bolds = new Set(
    line.tokens.flatMap((token) => (token.bold === undefined ? [] : [token.bold])),
  );
  if (bolds.has(true)) notes.push("Bold");
  if (bolds.has(false)) notes.push("Not bold");
  return notes.join(", ");
}

function markOf(token: Token): ConfirmDocSpan["mark"] {
  if (token.removed) return "removed";
  return token.added ? "added" : undefined;
}

function spansOf(tokens: Token[], whole: boolean): ConfirmDocSpan[] {
  const spans: ConfirmDocSpan[] = [];
  for (const token of tokens) {
    const mark = whole ? undefined : markOf(token);
    const ch = token.ch === OBJECT_CHAR ? "[object]" : token.ch;
    const last = spans.at(-1);
    if (last !== undefined && last.mark === mark) last.text += ch;
    else spans.push(mark === undefined ? { text: ch } : { text: ch, mark });
  }
  return spans;
}

type Drawn = { paragraph: ConfirmDocParagraph; changed: boolean };

function draw(line: Line): Drawn {
  const format = line.end.format ?? { style: "NORMAL_TEXT", bullet: false };
  const added = line.end.added && line.tokens.every((token) => token.added && !token.removed);
  const removed = line.end.removed && line.tokens.every((token) => token.removed);
  const change = added ? "added" : removed ? "removed" : undefined;
  const marked = line.tokens.some((token) => token.added || token.removed);
  const note = change === undefined ? noteOf(line) : "";
  const paragraph: ConfirmDocParagraph = {
    style: STYLES[format.style] ?? "normal",
    spans: spansOf(line.tokens, change !== undefined),
    ...(format.bullet ? { bullet: true } : {}),
    ...(change === undefined ? {} : { change }),
    ...(note === "" ? {} : { note }),
  };
  return { paragraph, changed: change !== undefined || marked || note !== "" };
}

/** Changed paragraphs with one neighbour either side; longer unchanged runs folded. */
function blocksOf(drawn: Drawn[]): ConfirmDocBlock[] {
  const near = (i: number) =>
    drawn[i]?.changed === true || drawn[i - 1]?.changed === true || drawn[i + 1]?.changed === true;
  const blocks: ConfirmDocBlock[] = [];
  let folded: ConfirmDocParagraph[] = [];
  const flush = () => {
    const [only] = folded;
    if (folded.length === 1 && only !== undefined) blocks.push(only);
    else if (folded.length > 1) blocks.push({ unchanged: folded });
    folded = [];
  };
  drawn.forEach((each, i) => {
    if (near(i)) {
      flush();
      blocks.push(each.paragraph);
    } else {
      folded.push(each.paragraph);
    }
  });
  flush();
  return blocks;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function countsOf(ops: Operation[], drawn: Drawn[], elsewhere: number): string {
  const by = (test: (each: Drawn) => boolean) => drawn.filter(test).length;
  const added = by((each) => each.paragraph.change === "added");
  const removed = by((each) => each.paragraph.change === "removed");
  const edited = by(
    (each) =>
      each.paragraph.change === undefined &&
      each.paragraph.spans.some((span) => span.mark !== undefined),
  );
  const restyled = by((each) => each.paragraph.note !== undefined);
  const parts = [
    added === 0 ? null : `${plural(added, "paragraph", "paragraphs")} added`,
    removed === 0 ? null : `${removed} removed`,
    edited === 0 ? null : `${edited} edited`,
    restyled === 0 ? null : `${restyled} restyled`,
  ].filter((each) => each !== null);
  const head = `${plural(ops.length, "change", "changes")}${parts.length === 0 ? "" : `: ${parts.join(", ")}`}`;
  const other =
    elsewhere === 0
      ? ""
      : `; also ${plural(elsewhere, "match", "matches")} in headers, footers or footnotes, not shown`;
  return `${head}${other}`;
}

/** The Doc as `ops` leave it, for the confirm card. */
export function redlineOf(structure: Structure, ops: Operation[]): ConfirmDoc {
  const after = lines(tokensAfter(structure, ops));
  let elsewhere = 0;
  for (const op of ops) {
    if (op.type !== "replace_text") continue;
    for (const line of after) replaceIn(line, op);
    elsewhere += op.matchCase
      ? count(structure.otherText, op.find)
      : count(structure.otherText.toLowerCase(), op.find.toLowerCase());
  }
  const drawn = after.map(draw);
  return { counts: countsOf(ops, drawn, elsewhere), blocks: blocksOf(drawn) };
}
