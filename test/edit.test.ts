import { expect, test } from "bun:test";
import {
  batchBody,
  contentOf,
  type Operation,
  type Plan,
  parseOperations,
  planEdit,
  summaryOf,
} from "../edit";
import { parseStructure, type Structure } from "../structure";
import { documentOf } from "./fake-drive";

// Indexes: "Intro\n" 1–7 (heading), "Hello world\n" 7–19, "Second para\n" 19–31; body ends at 31.
const STRUCTURE: Structure = parseStructure(
  documentOf([
    { text: "Intro\n", style: "HEADING_1" },
    { text: "Hello world\n" },
    { text: "Second para\n" },
  ]),
);
const BODY = "Intro\nHello world\nSecond para\n";

type Req = Record<string, Record<string, unknown>>;

/**
 * What Google does with the batch's text requests, in order, on the body
 * text (index 1 is its first character). Style requests move nothing and are
 * checked on their own.
 */
function apply(text: string, requests: Record<string, unknown>[]): string {
  let body = text;
  for (const raw of requests) {
    const request = raw as Req;
    const insert = request["insertText"];
    const remove = request["deleteContentRange"];
    const replace = request["replaceAllText"];
    if (insert !== undefined) {
      const index = (insert["location"] as { index: number }).index;
      body = body.slice(0, index - 1) + String(insert["text"]) + body.slice(index - 1);
    } else if (remove !== undefined) {
      const { startIndex, endIndex } = remove["range"] as { startIndex: number; endIndex: number };
      body = body.slice(0, startIndex - 1) + body.slice(endIndex - 1);
    } else if (replace !== undefined) {
      const find = (replace["containsText"] as { text: string }).text;
      body = body.replaceAll(find, String(replace["replaceText"]));
    }
  }
  return body;
}

function plan(ops: Operation[]): Plan {
  const planned = planEdit(STRUCTURE, ops);
  if (typeof planned === "string") throw new Error(planned);
  return planned;
}

function parsed(raw: unknown[]): Operation[] {
  const ops = parseOperations(raw);
  if (typeof ops === "string") throw new Error(ops);
  return ops;
}

test("inserts and deletes given low index first still land where the structure showed", () => {
  const ops = parsed([
    { type: "insert", text: "New. ", index: 7 },
    { type: "delete_range", startIndex: 12, endIndex: 18 },
    { type: "insert", text: "X", index: 19 },
  ]);
  const { requests } = plan(ops);
  expect(apply(BODY, requests)).toBe("Intro\nNew. Hello\nXSecond para\n");
  // Highest index first.
  expect(requests.map((each) => Object.keys(each)[0])).toEqual([
    "insertText",
    "deleteContentRange",
    "insertText",
  ]);
});

test("a delete and an insert at one index replace the text; two inserts there keep their order", () => {
  const swap = parsed([
    { type: "insert", text: "Bye", index: 7 },
    { type: "delete_range", startIndex: 7, endIndex: 12 },
  ]);
  expect(apply(BODY, plan(swap).requests)).toBe("Intro\nBye world\nSecond para\n");
  const two = parsed([
    { type: "insert", text: "A", index: 19 },
    { type: "insert", text: "B", index: 19 },
  ]);
  expect(apply(BODY, plan(two).requests)).toBe("Intro\nHello world\nABSecond para\n");
  const atEnd = parsed([
    { type: "delete_range", startIndex: 7, endIndex: 12 },
    { type: "insert", text: "!", index: 12 },
  ]);
  expect(apply(BODY, plan(atEnd).requests)).toBe("Intro\n! world\nSecond para\n");
});

test("insert after a heading makes normal-text paragraphs right under it", () => {
  const { requests, notes } = plan(
    parsed([{ type: "insert", text: "Body line\n", after_heading: " intro " }]),
  );
  expect(apply(BODY, requests)).toBe("Intro\nBody line\nHello world\nSecond para\n");
  expect(requests[0]).toEqual({ insertText: { location: { index: 6 }, text: "\nBody line" } });
  // The new paragraph is 7–17 after the insert: "Body line" and the heading's old newline.
  expect(requests[1]).toEqual({
    updateParagraphStyle: {
      range: { startIndex: 7, endIndex: 17 },
      paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
      fields: "namedStyleType",
    },
  });
  expect(notes[0]?.content).toBe('Insert after the heading "Intro":\n    Body line');
  expect(notes[0]?.sentence("Plan")).toBe('Insert new text under the heading "Intro" in "Plan".');
});

test("insert after a heading combines with later edits by index", () => {
  const ops = parsed([
    { type: "insert", text: "Body", after_heading: "Intro" },
    { type: "delete_range", startIndex: 19, endIndex: 26 },
  ]);
  expect(apply(BODY, plan(ops).requests)).toBe("Intro\nBody\nHello world\npara\n");
});

test("styles go first at the structure's indexes and replace_text goes last", () => {
  const ops = parsed([
    { type: "replace_text", find: "Hello", replace: "Hi" },
    { type: "insert", text: "Top\n", index: 7 },
    { type: "style", startIndex: 19, endIndex: 31, heading: 2, bold: true, bullet: true },
  ]);
  const { requests } = plan(ops);
  expect(requests.map((each) => Object.keys(each)[0])).toEqual([
    "updateParagraphStyle",
    "updateTextStyle",
    "createParagraphBullets",
    "insertText",
    "replaceAllText",
  ]);
  const range = { startIndex: 19, endIndex: 31 };
  expect(requests[0]).toEqual({
    updateParagraphStyle: {
      range,
      paragraphStyle: { namedStyleType: "HEADING_2" },
      fields: "namedStyleType",
    },
  });
  expect(requests[1]).toEqual({
    updateTextStyle: { range, textStyle: { bold: true }, fields: "bold" },
  });
  expect(apply(BODY, requests)).toBe("Intro\nTop\nHi world\nSecond para\n");
});

test("replace_text is held to the first tab and counts headers and inserted text on the card", () => {
  const structure = parseStructure(
    documentOf([{ text: "Hello world\n" }], "rev-1", { header: "world header\n", tabs: 3 }),
  );
  expect(structure.tabId).toBe("t.0");
  expect(structure.paragraphs.map((each) => each.text)).toEqual(["Hello world\n"]);
  const planned = planEdit(
    structure,
    parsed([
      { type: "replace_text", find: "world", replace: "there" },
      { type: "insert", text: "new world\n", index: 1 },
    ]),
  );
  if (typeof planned === "string") throw new Error(planned);
  expect(planned.requests.at(-1)).toEqual({
    replaceAllText: {
      containsText: { text: "world", matchCase: true },
      replaceText: "there",
      tabsCriteria: { tabIds: ["t.0"] },
    },
  });
  expect(planned.notes[0]?.content).toBe(
    "Replace every match (1 in the body, 1 in headers, footers or footnotes, 1 in text this edit inserts; matching case):\n    world\n  →\n    there",
  );
  expect(planned.notes[0]?.sentence("Budget plan")).toBe(
    'Replace 3 matches of "world" with "there" in "Budget plan".',
  );
});

test("a find only in a header still counts as in the Doc", () => {
  const structure = parseStructure(documentOf([{ text: "Hi\n" }], "rev-1", { header: "Draft\n" }));
  const planned = planEdit(
    structure,
    parsed([{ type: "replace_text", find: "Draft", replace: "" }]),
  );
  expect(typeof planned === "string" ? planned : planned.notes[0]?.content).toContain(
    "1 in headers, footers or footnotes",
  );
});

test("an answer without tabs reads the top-level body and sends no tabsCriteria", () => {
  const structure = parseStructure({
    documentId: "d",
    revisionId: "r",
    body: {
      content: [
        {
          startIndex: 1,
          endIndex: 4,
          paragraph: { elements: [{ startIndex: 1, endIndex: 4, textRun: { content: "ab\n" } }] },
        },
      ],
    },
  });
  expect(structure.tabId).toBeNull();
  const planned = planEdit(structure, parsed([{ type: "replace_text", find: "ab", replace: "c" }]));
  if (typeof planned === "string") throw new Error(planned);
  expect(planned.requests[0]).toEqual({
    replaceAllText: { containsText: { text: "ab", matchCase: true }, replaceText: "c" },
  });
});

test("the batch always holds the edit to the revision it was read at", () => {
  const body = batchBody(plan(parsed([{ type: "insert", text: "x", index: 1 }])), "rev-1");
  expect(body["writeControl"]).toEqual({ requiredRevisionId: "rev-1" });
});

test("the confirm notes show the exact text inserted, deleted and replaced, without indexes", () => {
  const planned = plan(
    parsed([
      { type: "delete_range", startIndex: 7, endIndex: 12 },
      { type: "replace_text", find: "para", replace: "part", matchCase: false },
    ]),
  );
  const [deleted, replaced] = planned.notes;
  expect(deleted?.content).toBe("Delete:\n    Hello");
  expect(deleted?.sentence("Plan")).toBe('Delete "Hello" from "Plan".');
  expect(replaced?.content).toBe(
    "Replace every match (1 in the body; ignoring case):\n    para\n  →\n    part",
  );
  expect(contentOf(planned)).toStartWith("1. Delete:\n    Hello\n\n2. Replace every match");
  expect(summaryOf(planned, "Plan")).toBe('Make 2 changes to "Plan".');
  const single = plan(parsed([{ type: "replace_text", find: "para", replace: "part" }]));
  expect(summaryOf(single, "Plan")).toBe('Replace 1 match of "para" with "part" in "Plan".');
});

test("edits that cannot be built say why and build nothing", () => {
  const error = (raw: unknown[]) => {
    const ops = parseOperations(raw);
    return typeof ops === "string" ? ops : planEdit(STRUCTURE, ops);
  };
  expect(
    error([
      { type: "delete_range", startIndex: 7, endIndex: 19 },
      { type: "insert", text: "x", index: 10 },
    ]),
  ).toBe("Not sent: operations 1 and 2 touch the same text: split them into two edits.");
  expect(
    error([
      { type: "delete_range", startIndex: 7, endIndex: 15 },
      { type: "delete_range", startIndex: 12, endIndex: 19 },
    ]),
  ).toContain("touch the same text");
  expect(error([{ type: "delete_range", startIndex: 20, endIndex: 31 }])).toContain(
    "outside the body",
  );
  expect(error([{ type: "insert", text: "x", index: 31 }])).toContain("outside the body");
  expect(error([{ type: "insert", text: "x", after_heading: "Nope" }])).toBe(
    'Operation 1: no heading reads "Nope"; the headings are "Intro".',
  );
  expect(error([{ type: "replace_text", find: "absent", replace: "x" }])).toBe(
    'Operation 1: "absent" is not in the Doc.',
  );
  expect(error([{ type: "style", startIndex: 1, endIndex: 5 }])).toBe(
    "Operation 1: style needs heading, bold or bullet.",
  );
  expect(error([])).toBe("operations needs at least one operation");
  expect(error([{ type: "rename" }])).toContain("unknown operation type");
});
