/**
 * `google_docs_edit`'s operations turned into one `documents.batchUpdate`,
 * against the structure they were read from. Pure: no request here.
 *
 * Google applies a batch's requests in order, and every insert or delete
 * moves the indexes after it. So the batch is built in three phases, every
 * index in it the one the reader's structure shows:
 *   1. styles — they move no index;
 *   2. inserts and deletes from the highest index down, so none moves the
 *      text a later one points at (at one index: deletes first, then inserts
 *      last-given first, so the inserted text reads in the given order);
 *   3. replace_text, which finds its text wherever it ends up.
 */

import { headingLevel, type Paragraph, type Structure, textInRange } from "./structure";

export type ReplaceOp = { type: "replace_text"; find: string; replace: string; matchCase: boolean };
export type InsertOp = { type: "insert"; text: string; afterHeading: string | null; index: number };
export type DeleteOp = { type: "delete_range"; startIndex: number; endIndex: number };
export type StyleOp = {
  type: "style";
  startIndex: number;
  endIndex: number;
  heading: number | null;
  bold: boolean | null;
  bullet: boolean | null;
};
export type Operation = ReplaceOp | InsertOp | DeleteOp | StyleOp;

type Request = Record<string, unknown>;

export type Plan = {
  requests: Request[];
  /** One line (or block) per operation, in the order given: what the reader confirms. */
  lines: string[];
};

// --- Reading the arguments --------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function int(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function flag(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function parseReplace(raw: Record<string, unknown>): ReplaceOp | string {
  const find = raw["find"];
  const replace = raw["replace"];
  if (typeof find !== "string" || find === "") return "replace_text needs a non-empty find";
  if (typeof replace !== "string") return 'replace_text needs replace (a string, "" to remove)';
  return { type: "replace_text", find, replace, matchCase: raw["matchCase"] !== false };
}

function parseInsert(raw: Record<string, unknown>): InsertOp | string {
  const text = raw["text"];
  if (typeof text !== "string" || text === "") return "insert needs a non-empty text";
  const heading = raw["after_heading"];
  const index = int(raw["index"]);
  if (typeof heading === "string" && heading.trim() !== "") {
    if (index !== null) return "insert takes after_heading or index, not both";
    return { type: "insert", text, afterHeading: heading, index: -1 };
  }
  if (index === null) return "insert needs after_heading or an index";
  return { type: "insert", text, afterHeading: null, index };
}

function parseRange(raw: Record<string, unknown>, type: string): [number, number] | string {
  const start = int(raw["startIndex"]);
  const end = int(raw["endIndex"]);
  if (start === null || end === null) return `${type} needs whole-number startIndex and endIndex`;
  if (start >= end) return `${type} needs startIndex below endIndex`;
  return [start, end];
}

function parseStyle(raw: Record<string, unknown>): StyleOp | string {
  const range = parseRange(raw, "style");
  if (typeof range === "string") return range;
  const heading = raw["heading"] === undefined ? null : int(raw["heading"]);
  if (raw["heading"] !== undefined && (heading === null || heading < 0 || heading > 6)) {
    return "style's heading is 0 (normal text) to 6";
  }
  const bold = flag(raw["bold"]);
  const bullet = flag(raw["bullet"]);
  if (heading === null && bold === null && bullet === null) {
    return "style needs heading, bold or bullet";
  }
  return { type: "style", startIndex: range[0], endIndex: range[1], heading, bold, bullet };
}

function parseOne(raw: unknown): Operation | string {
  if (!isRecord(raw)) return "each operation is an object with a type";
  switch (raw["type"]) {
    case "replace_text":
      return parseReplace(raw);
    case "insert":
      return parseInsert(raw);
    case "delete_range": {
      const range = parseRange(raw, "delete_range");
      if (typeof range === "string") return range;
      return { type: "delete_range", startIndex: range[0], endIndex: range[1] };
    }
    case "style":
      return parseStyle(raw);
    default:
      return `unknown operation type ${JSON.stringify(raw["type"])}: use replace_text, insert, delete_range or style`;
  }
}

/** The operations of a tool call, or what is wrong with them. */
export function parseOperations(raw: unknown): Operation[] | string {
  if (!Array.isArray(raw) || raw.length === 0) return "operations needs at least one operation";
  const ops: Operation[] = [];
  for (const [n, each] of raw.entries()) {
    const op = parseOne(each);
    if (typeof op === "string") return `Operation ${n + 1}: ${op}.`;
    ops.push(op);
  }
  return ops;
}

// --- Planning ----------------------------------------------------------

/** A step of phase 2: an insert or a delete, at the index it is sorted by. */
type Step = { at: number; given: number; kind: "insert" | "delete"; requests: Request[] };

function block(text: string): string {
  return text
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
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

function bodyText(structure: Structure): string {
  return structure.paragraphs.map((each) => each.text).join("");
}

function findHeading(structure: Structure, wanted: string): Paragraph | string {
  const name = wanted.trim().toLowerCase();
  const headings = structure.paragraphs.filter((each) => headingLevel(each.style) !== null);
  const matches = headings.filter((each) => each.text.trim().toLowerCase() === name);
  const [first, second] = matches;
  if (first !== undefined && second === undefined) return first;
  if (first !== undefined) {
    return `${matches.length} headings read "${wanted}": insert at an index instead`;
  }
  const known = headings.map((each) => JSON.stringify(each.text.trim())).join(", ");
  return `no heading reads "${wanted}"${known === "" ? " (the Doc has no headings)" : `; the headings are ${known}`}`;
}

function planInsert(op: InsertOp, structure: Structure, given: number): [Step, string] | string {
  if (op.afterHeading === null) {
    if (op.index < 1 || op.index >= structure.bodyEnd) {
      return `insert's index ${op.index} is outside the body (1 to ${structure.bodyEnd - 1})`;
    }
    const request = { insertText: { location: { index: op.index }, text: op.text } };
    return [
      { at: op.index, given, kind: "insert", requests: [request] },
      `Insert at index ${op.index}:\n${block(op.text)}`,
    ];
  }
  const heading = findHeading(structure, op.afterHeading);
  if (typeof heading === "string") return heading;
  // A newline at the heading's own newline splits it: the new paragraphs follow
  // the heading and are set back to normal text, whatever comes after it.
  const at = heading.endIndex - 1;
  const body = op.text.replace(/\n+$/, "");
  const text = `\n${body}`;
  const requests: Request[] = [
    { insertText: { location: { index: at }, text } },
    {
      updateParagraphStyle: {
        range: { startIndex: heading.endIndex, endIndex: heading.endIndex + body.length + 1 },
        paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
        fields: "namedStyleType",
      },
    },
  ];
  return [
    { at, given, kind: "insert", requests },
    `Insert after the heading ${JSON.stringify(heading.text.trim())} (index ${heading.endIndex}):\n${block(body)}`,
  ];
}

function planDelete(op: DeleteOp, structure: Structure, given: number): [Step, string] | string {
  if (op.startIndex < 1 || op.endIndex > structure.bodyEnd - 1) {
    return `delete_range ${op.startIndex}–${op.endIndex} is outside the body (1 to ${structure.bodyEnd - 1}; the body's last newline stays)`;
  }
  const range = { startIndex: op.startIndex, endIndex: op.endIndex };
  return [
    { at: op.startIndex, given, kind: "delete", requests: [{ deleteContentRange: { range } }] },
    `Delete ${op.startIndex}–${op.endIndex}:\n${block(textInRange(structure.runs, op.startIndex, op.endIndex))}`,
  ];
}

const BULLETS = "BULLET_DISC_CIRCLE_SQUARE";

function styleRequests(op: StyleOp): Request[] {
  const range = { startIndex: op.startIndex, endIndex: op.endIndex };
  const requests: Request[] = [];
  if (op.heading !== null) {
    const namedStyleType = op.heading === 0 ? "NORMAL_TEXT" : `HEADING_${op.heading}`;
    requests.push({
      updateParagraphStyle: { range, paragraphStyle: { namedStyleType }, fields: "namedStyleType" },
    });
  }
  if (op.bold !== null) {
    requests.push({ updateTextStyle: { range, textStyle: { bold: op.bold }, fields: "bold" } });
  }
  if (op.bullet === true)
    requests.push({ createParagraphBullets: { range, bulletPreset: BULLETS } });
  if (op.bullet === false) requests.push({ deleteParagraphBullets: { range } });
  return requests;
}

function planStyle(op: StyleOp, structure: Structure): [Request[], string] | string {
  if (op.startIndex < 1 || op.endIndex > structure.bodyEnd) {
    return `style ${op.startIndex}–${op.endIndex} is outside the body (1 to ${structure.bodyEnd})`;
  }
  // Google turns a paragraph's leading tabs into nesting and removes them, which moves indexes.
  const tabbed = structure.paragraphs.some(
    (each) =>
      each.startIndex < op.endIndex && each.endIndex > op.startIndex && each.text.startsWith("\t"),
  );
  if (op.bullet === true && tabbed) {
    return `a paragraph in ${op.startIndex}–${op.endIndex} starts with a tab: delete the tab first, in its own edit`;
  }
  const what: string[] = [];
  if (op.heading !== null) what.push(op.heading === 0 ? "normal text" : `heading ${op.heading}`);
  if (op.bold !== null) what.push(op.bold ? "bold" : "not bold");
  if (op.bullet !== null) what.push(op.bullet ? "bullet list" : "no bullets");
  const excerpt = textInRange(structure.runs, op.startIndex, op.endIndex).replace(/\n$/, "");
  return [
    styleRequests(op),
    `Style ${op.startIndex}–${op.endIndex} as ${what.join(", ")}:\n${block(excerpt)}`,
  ];
}

function where(found: number, place: string): string | null {
  return found === 0 ? null : `${found} in ${place}`;
}

/**
 * `replaceAllText` held to the structure's tab (left out, Google replaces in
 * every tab). It reaches the tab's headers, footers and footnotes too, and
 * text this same edit inserts, as it runs last: the card counts all three.
 */
function planReplace(
  op: ReplaceOp,
  structure: Structure,
  inserted: string,
): [Request, string] | string {
  const matches = (text: string) =>
    op.matchCase ? count(text, op.find) : count(text.toLowerCase(), op.find.toLowerCase());
  const body = matches(bodyText(structure));
  const other = matches(structure.otherText);
  const added = matches(inserted);
  if (body + other === 0) return `${JSON.stringify(op.find)} is not in the Doc`;
  const replaceAllText: Request = {
    containsText: { text: op.find, matchCase: op.matchCase },
    replaceText: op.replace,
  };
  if (structure.tabId !== null) replaceAllText["tabsCriteria"] = { tabIds: [structure.tabId] };
  const places = [
    where(body, "the body"),
    where(other, "headers, footers or footnotes"),
    where(added, "text this edit inserts"),
  ].filter((each) => each !== null);
  const how = op.matchCase ? "matching case" : "ignoring case";
  return [
    { replaceAllText },
    `Replace every ${JSON.stringify(op.find)} (${places.join(", ")}; ${how}) with:\n${block(op.replace)}`,
  ];
}

/** Two steps that cannot both run in one batch: a delete overlapping another, or holding an insert. */
function clash(a: Step, b: Step, ops: Operation[]): boolean {
  const range = (step: Step): [number, number] => {
    const op = ops[step.given];
    return op?.type === "delete_range" ? [op.startIndex, op.endIndex] : [step.at, step.at];
  };
  const [a1, a2] = range(a);
  const [b1, b2] = range(b);
  if (a.kind === "delete" && b.kind === "delete") return a1 < b2 && b1 < a2;
  if (a.kind === "delete" && b.kind === "insert") return a1 < b1 && b1 < a2;
  if (a.kind === "insert" && b.kind === "delete") return b1 < a1 && a1 < b2;
  return false;
}

function findClash(steps: Step[], ops: Operation[]): string | null {
  for (const [i, a] of steps.entries()) {
    for (const b of steps.slice(i + 1)) {
      if (clash(a, b, ops)) {
        return `operations ${a.given + 1} and ${b.given + 1} touch the same text: split them into two edits`;
      }
    }
  }
  return null;
}

/** Highest index first; at one index deletes first, then inserts last-given first. */
function order(a: Step, b: Step): number {
  if (a.at !== b.at) return b.at - a.at;
  if (a.kind !== b.kind) return a.kind === "delete" ? -1 : 1;
  return b.given - a.given;
}

/** The three phases, and the text the edit's inserts add (which replace_text also reaches). */
type Phases = { styles: Request[]; steps: Step[]; replaces: Request[]; inserted: string };

/** Puts one operation's requests in their phase; answers its confirm line, or what is wrong. */
function planOne(
  op: Operation,
  given: number,
  structure: Structure,
  phases: Phases,
): { line: string } | { error: string } {
  if (op.type === "style") {
    const planned = planStyle(op, structure);
    if (typeof planned === "string") return { error: planned };
    phases.styles.push(...planned[0]);
    return { line: planned[1] };
  }
  if (op.type === "replace_text") {
    const planned = planReplace(op, structure, phases.inserted);
    if (typeof planned === "string") return { error: planned };
    phases.replaces.push(planned[0]);
    return { line: planned[1] };
  }
  const planned =
    op.type === "insert" ? planInsert(op, structure, given) : planDelete(op, structure, given);
  if (typeof planned === "string") return { error: planned };
  phases.steps.push(planned[0]);
  return { line: planned[1] };
}

/** The batch for `ops` against `structure`, or why it cannot be built. */
export function planEdit(structure: Structure, ops: Operation[]): Plan | string {
  const inserted = ops
    .map((each) => (each.type === "insert" ? each.text : ""))
    .filter((each) => each !== "")
    .join("\n");
  const phases: Phases = { styles: [], steps: [], replaces: [], inserted };
  const lines: string[] = [];
  for (const [given, op] of ops.entries()) {
    const planned = planOne(op, given, structure, phases);
    if ("error" in planned) return `Operation ${given + 1}: ${planned.error}.`;
    lines.push(`${given + 1}. ${planned.line}`);
  }
  const clashing = findClash(phases.steps, ops);
  if (clashing !== null) return `Not sent: ${clashing}.`;
  const steps = [...phases.steps].sort(order);
  const requests = [
    ...phases.styles,
    ...steps.flatMap((each) => each.requests),
    ...phases.replaces,
  ];
  return { requests, lines };
}

/** The whole `documents.batchUpdate` body: the requests, held to the revision they were read at. */
export function batchBody(plan: Plan, revisionId: string): Record<string, unknown> {
  return { requests: plan.requests, writeControl: { requiredRevisionId: revisionId } };
}
