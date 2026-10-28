/**
 * What each `batchUpdate` request kind of the Docs and Sheets APIs does, in words, for the first line
 * of the confirm card. A table per API maps a request kind (the one key of a `Request` object) to a
 * reading; a new kind is one line. A reading gets every request of its kind in the call (the value
 * under the kind's key) and answers a lower-case phrase: "accept 3 suggestions".
 */

import { field, isRecord, str } from "./drive";

type Reading = (bodies: unknown[]) => string;
type Readings = Record<string, Reading>;

/** At most this many distinct readings are listed; past it the first stands and the rest are counted. */
const MAX_READINGS = 4;

/** The same words however many requests there are. */
const fixed =
  (words: string): Reading =>
  () =>
    words;

/** `one` for a single request, `more` with `{n}` for the number of requests otherwise. */
const counted =
  (one: string, more: string): Reading =>
  (bodies) =>
    bodies.length === 1 ? one : more.replace("{n}", String(bodies.length));

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function quoted(value: unknown): string | null {
  const text = str(value);
  return text === null ? null : JSON.stringify(text.length > 40 ? `${text.slice(0, 39)}…` : text);
}

/** A field of the first request that has it. */
function firstField(bodies: unknown[], ...path: string[]): unknown {
  for (const body of bodies) {
    const value = path.reduce((each: unknown, key) => field(each, key), body);
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

/** What a field of an `updateTextStyle` mask is read as; a field not listed reads as a style change. */
const STYLE_FIELDS: Record<string, string> = {
  bold: "make text bold",
  italic: "make text italic",
  underline: "underline text",
  strikethrough: "strike text through",
  foregroundColor: "change text color",
  backgroundColor: "highlight text",
  fontSize: "change text size",
  weightedFontFamily: "change the font",
  link: "add a link",
  baselineOffset: "raise or lower text",
  smallCaps: "set text in small caps",
};

function textStyle(bodies: unknown[]): string {
  const words = new Set<string>();
  for (const body of bodies) {
    const mask = str(field(body, "fields")) ?? "";
    for (const each of mask.split(",")) {
      const name = each.trim().split(".")[0] ?? "";
      if (name !== "") words.add(STYLE_FIELDS[name] ?? "change text style");
    }
  }
  if (words.size > 1) words.delete("change text style");
  return words.size === 0 ? "change text style" : [...words].join(" and ");
}

function replaceAll(bodies: unknown[]): string {
  const find = quoted(firstField(bodies, "containsText", "text"));
  const into = quoted(firstField(bodies, "replaceText"));
  if (bodies.length > 1) return `replace text in ${bodies.length} places`;
  if (find === null || into === null) return "replace text everywhere";
  return `replace ${find} with ${into} everywhere`;
}

function findReplace(bodies: unknown[]): string {
  const find = quoted(firstField(bodies, "find"));
  const into = quoted(firstField(bodies, "replacement"));
  if (bodies.length > 1) return `find and replace in ${bodies.length} places`;
  if (find === null || into === null) return "find and replace text";
  return `replace ${find} with ${into} everywhere`;
}

function insertTable(bodies: unknown[]): string {
  if (bodies.length > 1) return `insert ${bodies.length} tables`;
  const rows = firstField(bodies, "rows");
  const columns = firstField(bodies, "columns");
  return typeof rows === "number" && typeof columns === "number"
    ? `insert a ${rows}×${columns} table`
    : "insert a table";
}

function insertText(bodies: unknown[]): string {
  return bodies.length === 1 ? "insert text" : `insert text in ${bodies.length} places`;
}

function tabTitle(verb: string, ...path: string[]): Reading {
  return (bodies) => {
    const title = quoted(firstField(bodies, ...path));
    if (bodies.length > 1) return `${verb} ${bodies.length} tabs`;
    return title === null ? `${verb} a tab` : `${verb} a tab ${title}`;
  };
}

function renameSheet(bodies: unknown[]): string {
  const title = quoted(firstField(bodies, "properties", "title"));
  if (bodies.length > 1) return `change the properties of ${bodies.length} tabs`;
  if (title === null) return "change a tab's properties";
  const id = firstField(bodies, "properties", "sheetId");
  return id === undefined || id === null
    ? `rename a tab to ${title}`
    : `rename tab ${String(id)} to ${title}`;
}

/** The Docs `Request` kinds. */
export const DOCS_READINGS: Readings = {
  acceptSuggestion: counted("accept a suggestion", "accept {n} suggestions"),
  rejectSuggestion: counted("reject a suggestion", "reject {n} suggestions"),
  deleteSuggestion: counted("delete a suggestion", "delete {n} suggestions"),
  addCommentReply: counted("reply to a comment", "reply to {n} comments"),
  addDocumentTab: tabTitle("add", "tabProperties", "title"),
  createDropdownDefinition: fixed("create a dropdown"),
  createFooter: fixed("add a footer"),
  createFootnote: counted("add a footnote", "add {n} footnotes"),
  createHeader: fixed("add a header"),
  createNamedRange: counted("name a range", "name {n} ranges"),
  createParagraphBullets: fixed("add bullets"),
  deleteComment: counted("delete a comment", "delete {n} comments"),
  deleteCommentReply: counted("delete a comment reply", "delete {n} comment replies"),
  deleteContentRange: counted("delete text", "delete text in {n} places"),
  deleteDropdownDefinition: fixed("delete a dropdown"),
  deleteFooter: fixed("delete a footer"),
  deleteHeader: fixed("delete a header"),
  deleteNamedRange: counted("delete a named range", "delete {n} named ranges"),
  deleteParagraphBullets: fixed("remove bullets"),
  deletePositionedObject: counted("delete a floating object", "delete {n} floating objects"),
  deleteTab: counted("delete a tab", "delete {n} tabs"),
  deleteTableColumn: counted("delete a table column", "delete {n} table columns"),
  deleteTableRow: counted("delete a table row", "delete {n} table rows"),
  insertComment: counted("add a comment", "add {n} comments"),
  insertDate: counted("insert a date", "insert {n} dates"),
  insertDropdown: counted("insert a dropdown", "insert {n} dropdowns"),
  insertInlineImage: counted("insert an image", "insert {n} images"),
  insertPageBreak: counted("insert a page break", "insert {n} page breaks"),
  insertPerson: counted("mention a person", "mention {n} people"),
  insertRichLink: counted("insert a link chip", "insert {n} link chips"),
  insertSectionBreak: counted("insert a section break", "insert {n} section breaks"),
  insertTable,
  insertTableColumn: counted("add a table column", "add {n} table columns"),
  insertTableRow: counted("add a table row", "add {n} table rows"),
  insertText,
  mergeTableCells: fixed("merge table cells"),
  pinTableHeaderRows: fixed("pin table header rows"),
  replaceAllText: replaceAll,
  replaceImage: counted("replace an image", "replace {n} images"),
  replaceNamedRangeContent: fixed("replace the content of a named range"),
  unmergeTableCells: fixed("split merged table cells"),
  updateCommentPost: counted("edit a comment", "edit {n} comments"),
  updateDocumentStyle: fixed("change the page setup"),
  updateDocumentTabProperties: fixed("change a tab's properties"),
  updateDropdownDefinitionProperties: fixed("change a dropdown's options"),
  updateDropdownProperties: fixed("change a dropdown"),
  updateNamedStyle: fixed("change a named style"),
  updateParagraphStyle: fixed("change paragraph style"),
  updateSectionStyle: fixed("change a section's layout"),
  updateTableCellStyle: fixed("style table cells"),
  updateTableColumnProperties: fixed("resize table columns"),
  updateTableRowStyle: fixed("style table rows"),
  updateTextStyle: textStyle,
};

/** The Sheets `Request` kinds. */
export const SHEETS_READINGS: Readings = {
  addBanding: fixed("add alternating colors"),
  addChart: counted("add a chart", "add {n} charts"),
  addCommentReply: counted("reply to a comment", "reply to {n} comments"),
  addConditionalFormatRule: counted("add a conditional format", "add {n} conditional formats"),
  addDataSource: fixed("add a data source"),
  addDimensionGroup: fixed("group rows or columns"),
  addFilterView: fixed("add a filter view"),
  addNamedRange: counted("name a range", "name {n} ranges"),
  addProtectedRange: counted("protect a range", "protect {n} ranges"),
  addSheet: tabTitle("add", "properties", "title"),
  addSlicer: fixed("add a slicer"),
  addTable: fixed("add a table"),
  appendCells: fixed("write cells"),
  appendDimension: fixed("add rows or columns at the end"),
  autoFill: fixed("auto-fill cells"),
  autoResizeDimensions: fixed("auto-resize rows or columns"),
  cancelDataSourceRefresh: fixed("cancel a data refresh"),
  clearBasicFilter: fixed("clear the filter"),
  copyPaste: fixed("copy and paste cells"),
  createDeveloperMetadata: fixed("add developer metadata"),
  cutPaste: fixed("move cells"),
  deleteBanding: fixed("remove alternating colors"),
  deleteComment: counted("delete a comment", "delete {n} comments"),
  deleteCommentReply: counted("delete a comment reply", "delete {n} comment replies"),
  deleteConditionalFormatRule: fixed("delete a conditional format"),
  deleteDataSource: fixed("delete a data source"),
  deleteDeveloperMetadata: fixed("delete developer metadata"),
  deleteDimension: fixed("delete cells"),
  deleteDimensionGroup: fixed("ungroup rows or columns"),
  deleteDuplicates: fixed("remove duplicate rows"),
  deleteEmbeddedObject: fixed("delete a chart or image"),
  deleteFilterView: fixed("delete a filter view"),
  deleteNamedRange: counted("delete a named range", "delete {n} named ranges"),
  deleteProtectedRange: fixed("remove range protection"),
  deleteRange: fixed("delete cells"),
  deleteSheet: counted("delete a tab", "delete {n} tabs"),
  deleteTable: fixed("delete a table"),
  duplicateFilterView: fixed("duplicate a filter view"),
  duplicateSheet: counted("duplicate a tab", "duplicate {n} tabs"),
  findReplace,
  insertComment: counted("add a comment", "add {n} comments"),
  insertDimension: fixed("insert rows or columns"),
  insertRange: fixed("insert cells"),
  mergeCells: fixed("merge cells"),
  moveDimension: fixed("move rows or columns"),
  pasteData: fixed("paste data"),
  randomizeRange: fixed("shuffle rows"),
  refreshDataSource: fixed("refresh a data source"),
  repeatCell: fixed("format cells"),
  setBasicFilter: fixed("set a filter"),
  setDataValidation: fixed("set a dropdown or validation rule"),
  sortRange: fixed("sort rows"),
  textToColumns: fixed("split text into columns"),
  trimWhitespace: fixed("trim whitespace in cells"),
  unmergeCells: fixed("unmerge cells"),
  updateBanding: fixed("change alternating colors"),
  updateBorders: fixed("change borders"),
  updateCells: fixed("write cells"),
  updateChartSpec: fixed("change a chart"),
  updateCommentPost: counted("edit a comment", "edit {n} comments"),
  updateConditionalFormatRule: fixed("change a conditional format"),
  updateDataSource: fixed("change a data source"),
  updateDeveloperMetadata: fixed("change developer metadata"),
  updateDimensionGroup: fixed("change a row or column group"),
  updateDimensionProperties: fixed("resize or hide rows or columns"),
  updateEmbeddedObjectBorder: fixed("change a chart's border"),
  updateEmbeddedObjectPosition: fixed("move a chart"),
  updateFilterView: fixed("change a filter view"),
  updateNamedRange: fixed("change a named range"),
  updateProtectedRange: fixed("change range protection"),
  updateSheetProperties: renameSheet,
  updateSlicerSpec: fixed("change a slicer"),
  updateSpreadsheetProperties: fixed("change the spreadsheet's settings"),
  updateTable: fixed("change a table"),
};

/** The kind a `Request` object is of: its one key. */
function kindOf(request: unknown): string | null {
  return isRecord(request) ? (Object.keys(request)[0] ?? null) : null;
}

/** The phrase for requests of a kind the tables do not know (a new API addition, or not a request). */
function otherChanges(n: number): string {
  return `${n} other ${n === 1 ? "change" : "changes"}`;
}

type Phrase = { text: string; changes: number };

/** The phrases for `requests`: one per kind, equal ones merged, those of unknown kinds last. */
function phrasesOf(readings: Readings, requests: unknown[]): Phrase[] {
  const groups = new Map<string, unknown[]>();
  let unknown = 0;
  for (const request of requests) {
    const kind = kindOf(request);
    if (kind === null || readings[kind] === undefined) unknown += 1;
    else groups.set(kind, [...(groups.get(kind) ?? []), field(request, kind)]);
  }
  const phrases: Phrase[] = [];
  for (const [kind, bodies] of groups) {
    const text = readings[kind]?.(bodies) ?? "";
    const known = phrases.find((each) => each.text === text);
    if (known === undefined) phrases.push({ text, changes: bodies.length });
    else known.changes += bodies.length;
  }
  if (unknown > 0) phrases.push({ text: otherChanges(unknown), changes: unknown });
  return phrases;
}

/**
 * One sentence for the requests of a `batchUpdate` body, ending in `target` ("the Google Doc \"Plan\"");
 * null when the body has no requests. Requests of a kind are one phrase, equal phrases are said once,
 * and past four phrases the first is followed by the number of changes left unsaid.
 */
export function describeRequests(
  readings: Readings,
  body: Record<string, unknown> | null,
  target: string,
): string | null {
  const requests = body === null ? null : field(body, "requests");
  if (!Array.isArray(requests) || requests.length === 0) return null;
  const phrases = phrasesOf(readings, requests);
  const first = phrases[0];
  if (first === undefined) return null;
  const sentence =
    phrases.length <= MAX_READINGS
      ? phrases.map((each) => each.text).join(" and ")
      : `${first.text} and ${plural(requests.length - first.changes, "more change")}`;
  const preposition = sentence.startsWith("add") ? "to" : "in";
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)} ${preposition} ${target}.`;
}
