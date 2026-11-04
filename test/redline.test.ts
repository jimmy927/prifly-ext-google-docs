import { expect, test } from "bun:test";
import { type Operation, parseOperations } from "../edit";
import { type ConfirmDocBlock, type ConfirmDocParagraph, redlineOf } from "../redline";
import { parseStructure } from "../structure";
import { documentOf } from "./fake-drive";

// Indexes: "Intro\n" 1–7 (heading), "Hello world\n" 7–19, "Second para\n" 19–31,
// "Third\n" 31–37, "Fourth\n" 37–44, "Fifth\n" 44–50; body ends at 50.
const STRUCTURE = parseStructure(
  documentOf(
    [
      { text: "Intro\n", style: "HEADING_1" },
      { text: "Hello world\n" },
      { text: "Second para\n" },
      { text: "Third\n" },
      { text: "Fourth\n" },
      { text: "Fifth\n" },
    ],
    "rev-1",
    { header: "Hello header\n" },
  ),
);

function ops(raw: unknown[]): Operation[] {
  const parsed = parseOperations(raw);
  if (typeof parsed === "string") throw new Error(parsed);
  return parsed;
}

function paragraphs(blocks: ConfirmDocBlock[]): ConfirmDocParagraph[] {
  return blocks.flatMap((each) => ("unchanged" in each ? each.unchanged : [each]));
}

test("an insert before a paragraph shows as an added paragraph in its place, with its neighbours", () => {
  const doc = redlineOf(STRUCTURE, ops([{ type: "insert", text: "New line\n", index: 19 }]));
  expect(doc.blocks.slice(0, 4)).toEqual([
    { unchanged: [{ style: "h1", spans: [{ text: "Intro" }] }] }
      .unchanged[0] as ConfirmDocParagraph,
    { style: "normal", spans: [{ text: "Hello world" }] },
    { style: "normal", spans: [{ text: "New line" }], change: "added" },
    { style: "normal", spans: [{ text: "Second para" }] },
  ]);
  // Third, Fourth and Fifth are more than one away: folded.
  expect(doc.blocks.at(-1)).toEqual({
    unchanged: [
      { style: "normal", spans: [{ text: "Third" }] },
      { style: "normal", spans: [{ text: "Fourth" }] },
      { style: "normal", spans: [{ text: "Fifth" }] },
    ],
  });
  expect(doc.counts).toBe("1 change: 1 paragraph added");
});

test("a delete inside a paragraph strikes that text; a whole paragraph deleted goes as one", () => {
  const doc = redlineOf(
    STRUCTURE,
    ops([
      { type: "delete_range", startIndex: 12, endIndex: 18 },
      { type: "delete_range", startIndex: 31, endIndex: 37 },
    ]),
  );
  const all = paragraphs(doc.blocks);
  expect(all[1]).toEqual({
    style: "normal",
    spans: [{ text: "Hello" }, { text: " world", mark: "removed" }],
  });
  expect(all[3]).toEqual({ style: "normal", spans: [{ text: "Third" }], change: "removed" });
  expect(doc.counts).toBe("2 changes: 1 removed, 1 edited");
});

test("replace_text marks the old words removed and the new added, and counts the header's", () => {
  const doc = redlineOf(STRUCTURE, ops([{ type: "replace_text", find: "Hello", replace: "Hi" }]));
  expect(paragraphs(doc.blocks)[1]).toEqual({
    style: "normal",
    spans: [{ text: "Hello", mark: "removed" }, { text: "Hi", mark: "added" }, { text: " world" }],
  });
  expect(doc.counts).toBe(
    "1 change: 1 edited; also 1 match in headers, footers or footnotes, not shown",
  );
});

test("replace_text reaches text the same edit inserts, which then reads as added only", () => {
  const doc = redlineOf(
    STRUCTURE,
    ops([
      { type: "insert", text: "Hello again\n", index: 31 },
      { type: "replace_text", find: "again", replace: "there" },
    ]),
  );
  expect(paragraphs(doc.blocks)[3]).toEqual({
    style: "normal",
    spans: [{ text: "Hello there" }],
    change: "added",
  });
});

test("an insert under a heading is normal text after it, and the heading stays a heading", () => {
  const doc = redlineOf(
    STRUCTURE,
    ops([{ type: "insert", text: "First\nSecond", after_heading: "Intro" }]),
  );
  expect(paragraphs(doc.blocks).slice(0, 4)).toEqual([
    { style: "h1", spans: [{ text: "Intro" }] },
    { style: "normal", spans: [{ text: "First" }], change: "added" },
    { style: "normal", spans: [{ text: "Second" }], change: "added" },
    { style: "normal", spans: [{ text: "Hello world" }] },
  ]);
});

test("a style change is a note on the paragraph, and the text is not marked", () => {
  const doc = redlineOf(
    STRUCTURE,
    ops([
      { type: "style", startIndex: 1, endIndex: 7, heading: 2 },
      { type: "style", startIndex: 19, endIndex: 31, bullet: true, bold: true },
    ]),
  );
  const all = paragraphs(doc.blocks);
  expect(all[0]).toEqual({
    style: "h2",
    spans: [{ text: "Intro" }],
    note: "Heading 1 → Heading 2",
  });
  expect(all[2]).toEqual({
    style: "normal",
    bullet: true,
    spans: [{ text: "Second para" }],
    note: "Bulleted, Bold",
  });
  expect(doc.counts).toBe("2 changes: 2 restyled");
});

test("a new paragraph inserted at a heading's start takes the heading's style, as Google gives it", () => {
  const doc = redlineOf(STRUCTURE, ops([{ type: "insert", text: "Above\n", index: 1 }]));
  expect(paragraphs(doc.blocks)[0]).toEqual({
    style: "h1",
    spans: [{ text: "Above" }],
    change: "added",
  });
});

test("indexes count UTF-16 units, so a character outside the BMP is deleted whole", () => {
  // "🚧 Gym\n" 1–8: the emoji takes indexes 1 and 2.
  const structure = parseStructure(documentOf([{ text: "🚧 Gym\n" }]));
  const doc = redlineOf(
    structure,
    ops([
      { type: "delete_range", startIndex: 1, endIndex: 3 },
      { type: "insert", text: "✅", index: 1 },
    ]),
  );
  expect(doc.blocks).toEqual([
    {
      style: "normal",
      spans: [
        { text: "✅", mark: "added" },
        { text: "🚧", mark: "removed" },
        { text: " Gym" },
      ],
    },
  ]);
});
