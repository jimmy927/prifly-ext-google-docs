import { expect, test } from "bun:test";
import { describeCall } from "../api-tools";
import { DOCS_READINGS, describeRequests, SHEETS_READINGS } from "../card-readings";
import { DOC_ID } from "./fake-drive";
import { setup } from "./helpers";
import { DOCS_REQUEST_KINDS, SHEETS_REQUEST_KINDS } from "./request-kinds";

const SHEET_ID = "sheet1";
const SHEETS = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}`;
const DOC = `https://docs.googleapis.com/v1/documents/${DOC_ID}`;

/** The first line of the card for a batchUpdate carrying `requests`. */
async function summaryOf(base: string, requests: unknown[], name = "Plan"): Promise<string> {
  const fake = setup({ info: { name } });
  await fake.callTool("google_docs_api", {
    method: "POST",
    path: `${base}:batchUpdate`,
    body: { requests },
  });
  return fake.confirms[0]?.summary ?? "";
}

test("the discovery fixtures hold every kind the issue counted", () => {
  expect(new Set(DOCS_REQUEST_KINDS).size).toBe(53);
  expect(new Set(SHEETS_REQUEST_KINDS).size).toBe(74);
});

test("every request kind of both APIs has a reading, and no reading is for a kind that is gone", () => {
  expect(Object.keys(DOCS_READINGS).sort()).toEqual([...DOCS_REQUEST_KINDS].sort());
  expect(Object.keys(SHEETS_READINGS).sort()).toEqual([...SHEETS_REQUEST_KINDS].sort());
  for (const [readings, kinds] of [
    [DOCS_READINGS, DOCS_REQUEST_KINDS],
    [SHEETS_READINGS, SHEETS_REQUEST_KINDS],
  ] as const) {
    for (const kind of kinds) {
      const sentence = describeRequests(readings, { requests: [{ [kind]: {} }] }, "T");
      expect(sentence).not.toBeNull();
      expect(sentence).not.toContain("other change");
      expect(sentence).toEndWith(" T.");
    }
  }
});

test("every request kind reads the same through the confirm card", async () => {
  for (const kind of DOCS_REQUEST_KINDS) {
    const summary = await summaryOf(DOC, [{ [kind]: {} }]);
    expect(summary).not.toContain("other change");
    expect(summary).not.toBe('Change the Google Doc "Plan".');
  }
  for (const kind of SHEETS_REQUEST_KINDS) {
    const summary = await summaryOf(SHEETS, [{ [kind]: {} }]);
    expect(summary).not.toContain("other change");
    expect(summary).not.toStartWith("Send a POST");
  }
});

test("request fields make the reading concrete", async () => {
  expect(
    await summaryOf(DOC, [
      { replaceAllText: { containsText: { text: "foo" }, replaceText: "bar" } },
    ]),
  ).toBe('Replace "foo" with "bar" everywhere in the Google Doc "Plan".');
  expect(await summaryOf(DOC, [{ insertTable: { rows: 3, columns: 4 } }])).toBe(
    'Insert a 3×4 table in the Google Doc "Plan".',
  );
  expect(await summaryOf(DOC, [{ updateTextStyle: { fields: "bold" } }])).toBe(
    'Make text bold in the Google Doc "Plan".',
  );
  expect(await summaryOf(DOC, [{ updateTextStyle: { fields: "italic,foregroundColor" } }])).toBe(
    'Make text italic and change text color in the Google Doc "Plan".',
  );
  expect(
    await summaryOf(SHEETS, [
      { updateSheetProperties: { properties: { sheetId: 7, title: "2027" }, fields: "title" } },
    ]),
  ).toBe('Rename tab 7 to "2027" in the spreadsheet "Plan".');
  expect(await summaryOf(SHEETS, [{ findReplace: { find: "a", replacement: "b" } }])).toBe(
    'Replace "a" with "b" everywhere in the spreadsheet "Plan".',
  );
  expect(await summaryOf(SHEETS, [{ addSheet: { properties: { title: "Q1" } } }])).toBe(
    'Add a tab "Q1" to the spreadsheet "Plan".',
  );
});

test("requests combine into one sentence, repeats are counted and equal readings said once", async () => {
  const accept = { acceptSuggestion: { suggestionId: "s" } };
  expect(await summaryOf(DOC, [accept, accept, accept, { insertText: { text: "x" } }])).toBe(
    'Accept 3 suggestions and insert text in the Google Doc "Plan".',
  );
  expect(await summaryOf(DOC, [accept])).toBe('Accept a suggestion in the Google Doc "Plan".');
  expect(await summaryOf(SHEETS, [{ updateCells: {} }, { appendCells: {} }])).toBe(
    'Write cells in the spreadsheet "Plan".',
  );
});

test("past four readings the first is named and the rest counted", async () => {
  const requests = [
    { acceptSuggestion: {} },
    { acceptSuggestion: {} },
    { insertText: {} },
    { createHeader: {} },
    { createFooter: {} },
    { insertPageBreak: {} },
  ];
  expect(await summaryOf(DOC, requests)).toBe(
    'Accept 2 suggestions and 4 more changes in the Google Doc "Plan".',
  );
  expect(await summaryOf(DOC, requests.slice(1, 5))).toBe(
    'Accept a suggestion and insert text and add a header and add a footer in the Google Doc "Plan".',
  );
});

test("a kind the tables do not know falls back to a count of other changes", async () => {
  expect(await summaryOf(DOC, [{ brandNewRequest: {} }])).toBe(
    '1 other change in the Google Doc "Plan".',
  );
  expect(await summaryOf(DOC, [{ insertText: {} }, { brandNew: {} }, "oops", {}])).toBe(
    'Insert text and 3 other changes in the Google Doc "Plan".',
  );
  expect(await summaryOf(SHEETS, [{ brandNewRequest: {} }, { sortRange: {} }])).toBe(
    'Sort rows and 1 other change in the spreadsheet "Plan".',
  );
});

test("no requests keeps the plain wording", async () => {
  expect(await summaryOf(DOC, [])).toBe('Change the Google Doc "Plan".');
});

test("Slides and Forms are named in the generic reading", async () => {
  const call = (host: string) => ({
    method: "POST",
    url: new URL(`https://${host}/v1/x:batchUpdate`),
    body: null,
  });
  expect(describeCall(call("slides.googleapis.com"), "Deck")).toBe(
    'Send a POST request to Google Slides about "Deck".',
  );
  expect(describeCall(call("forms.googleapis.com"), null)).toBe(
    "Send a POST request to Google Forms.",
  );
});
