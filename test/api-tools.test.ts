import { expect, test } from "bun:test";
import { apiDocsTool, DISCOVERY, resolveApiUrl, searchDiscovery } from "../api-tools";
import { CANCELLED } from "../common";
import { DOC_ID } from "./fake-drive";
import { expectPlainCard, setup } from "./helpers";

test("a GET runs at once with the account's token and answers status and body", async () => {
  const fake = setup({ info: { name: "Budget" } });
  const answer = await fake.callTool("google_docs_api", {
    path: `/drive/v3/files/${DOC_ID}`,
    query: { fields: "name" },
  });
  expect(answer).toStartWith("200");
  expect(answer).toContain('"name":"Budget"');
  expect(fake.confirms).toEqual([]);
  expect(fake.sent[0]?.url.href).toBe(
    `https://www.googleapis.com/drive/v3/files/${DOC_ID}?fields=name`,
  );
  expect(fake.requests[0]?.headers.get("Authorization")).toMatch(/^Bearer token-g1-/);
});

test("a write shows method, URL and body on the card and is sent only when confirmed", async () => {
  const fake = setup({ info: { name: "Budget plan" } });
  const args = {
    method: "post",
    path: `https://docs.googleapis.com/v1/documents/${DOC_ID}:batchUpdate`,
    body: { requests: [] },
  };
  expect(await fake.callTool("google_docs_api", args)).toStartWith("200");
  const card = fake.confirms[0];
  expect(card?.summary).toBe('Change the Google Doc "Budget plan".');
  expect(card?.content).toBeUndefined();
  expect(card?.details).toBe(
    `POST https://docs.googleapis.com/v1/documents/${DOC_ID}:batchUpdate\n\n{"requests":[]}`,
  );
  expectPlainCard(card, [`${DOC_ID}:batchUpdate`, '{"requests":[]}']);
  expect(card?.summary).not.toContain(DOC_ID);
  expect(fake.writes()[0]?.body).toBe('{"requests":[]}');
  fake.confirmAnswer.value = false;
  expect(await fake.callTool("google_docs_api", { ...args, method: "DELETE" })).toBe(CANCELLED);
  expect(fake.confirms[1]?.summary).toBe(
    'Send a DELETE request to Google Docs about "Budget plan".',
  );
  expect(fake.writes()).toHaveLength(1);
});

test("a Drive call is described in plain words and a flat body is shown as text", async () => {
  const fake = setup({ info: { name: "Budget plan" } });
  const path = `/drive/v3/files/${DOC_ID}`;
  await fake.callTool("google_docs_api", { method: "PATCH", path, body: { name: "Budget 2027" } });
  const card = fake.confirms[0];
  expect(card?.summary).toBe('Send a PATCH request to Drive about "Budget plan".');
  expect(card?.content).toBe("name: Budget 2027");
  expectPlainCard(card, [
    `PATCH https://www.googleapis.com/drive/v3/files/${DOC_ID}`,
    '{"name":"Budget 2027"}',
  ]);
  expect(card?.summary).not.toContain(DOC_ID);
  await fake.callTool("google_docs_api", { method: "DELETE", path });
  expect(fake.confirms[1]?.summary).toBe('Send a DELETE request to Drive about "Budget plan".');
  expect(fake.confirms[1]?.content).toBeUndefined();
});

test("only the Docs v1 and Drive v3 APIs are reached; anything else is refused without a request", async () => {
  const fake = setup();
  for (const path of [
    "https://gmail.googleapis.com/gmail/v1/users/me/messages",
    "https://www.googleapis.com/oauth2/v2/userinfo",
    "https://evil.example.com/v1/documents/x",
    "http://docs.googleapis.com/v1/documents/x",
    "https://docs.googleapis.com:444/v1/documents/x",
    "/drive/v3/../../oauth2/v2/userinfo",
    "/v2/documents/x",
    "documents/x",
  ]) {
    expect(await fake.callTool("google_docs_api", { path })).toStartWith("Refused");
  }
  expect(
    await fake.callTool("google_docs_api", { method: "TRACE", path: "/v1/documents/x" }),
  ).toStartWith("Refused");
  expect(fake.sent).toEqual([]);
  expect(resolveApiUrl("v1/documents/x")).toBeInstanceOf(URL);
  expect(String(resolveApiUrl("/drive/v3/files", { q: "a", spaces: ["drive", "x"] }))).toBe(
    "https://www.googleapis.com/drive/v3/files?q=a&spaces=drive&spaces=x",
  );
});

const DISCOVERY_DOC = {
  servicePath: "",
  resources: {
    documents: {
      methods: {
        batchUpdate: {
          id: "docs.documents.batchUpdate",
          httpMethod: "POST",
          path: "v1/documents/{documentId}:batchUpdate",
          description: "Applies one or more updates to the document.",
          parameters: {
            documentId: {
              location: "path",
              type: "string",
              required: true,
              description: "The ID.",
            },
          },
          request: { $ref: "BatchUpdateDocumentRequest" },
          response: { $ref: "BatchUpdateDocumentResponse" },
        },
        get: {
          id: "docs.documents.get",
          httpMethod: "GET",
          path: "v1/documents/{documentId}",
          description: "Gets the latest version of the specified document.",
        },
      },
    },
  },
  schemas: {
    InsertTextRequest: {
      description: "Inserts text at the specified location.",
      properties: {
        text: { type: "string", description: "The text." },
        location: { $ref: "Location" },
      },
    },
  },
};

test("the docs tool finds methods and schemas in the discovery document, fetched once", async () => {
  const fetched: string[] = [];
  const tool = apiDocsTool(async (url) => {
    fetched.push(url);
    return Response.json(DISCOVERY_DOC);
  });
  const ctx = {
    session: "s",
    pick: async () => null,
    signal: new AbortController().signal,
    scratchpad: "/",
  };
  const found = await tool.call({ api: "docs", query: "batchupdate" }, ctx);
  expect(found).toContain(
    "docs.documents.batchUpdate  POST /v1/documents/{documentId}:batchUpdate",
  );
  expect(found).toContain("documentId (path, string, required) — The ID.");
  expect(found).toContain("request body: BatchUpdateDocumentRequest");
  expect(found).not.toContain("docs.documents.get");
  const schema = await tool.call({ api: "docs", query: "insert text" }, ctx);
  expect(schema).toContain("schema InsertTextRequest: Inserts text at the specified location.");
  expect(schema).toContain("- location: Location");
  expect(await tool.call({ api: "docs", query: "" }, ctx)).toContain("docs.documents.get  GET");
  expect(fetched).toEqual([DISCOVERY["docs"] ?? ""]);
  expect(await tool.call({ api: "gmail", query: "" }, ctx)).toBe(
    'api is "docs", "drive" or "sheets".',
  );
});

const SHEET_ID = "sheet1";
const SHEETS = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}`;

test("Sheets v4 is allowed, a bare v4/ path resolves to it, other hosts stay refused", async () => {
  expect(String(resolveApiUrl("v4/spreadsheets/x"))).toBe(
    "https://sheets.googleapis.com/v4/spreadsheets/x",
  );
  expect(resolveApiUrl(`${SHEETS}/values/A1`)).toBeInstanceOf(URL);
  const fake = setup();
  for (const path of [
    "https://sheets.googleapis.com/v3/spreadsheets/x",
    "https://sheets.example.com/v4/spreadsheets/x",
    "http://sheets.googleapis.com/v4/spreadsheets/x",
    "https://script.googleapis.com/v4/spreadsheets/x",
  ]) {
    expect(await fake.callTool("google_docs_api", { path })).toStartWith("Refused");
  }
  expect(fake.sent).toEqual([]);
});

test("a Sheets GET runs at once without a card", async () => {
  const fake = setup({ info: { sheets: [] } });
  const answer = await fake.callTool("google_docs_api", {
    path: `/v4/spreadsheets/${SHEET_ID}`,
    query: { fields: "sheets.properties" },
  });
  expect(answer).toStartWith("200");
  expect(fake.confirms).toEqual([]);
  expect(fake.sent[0]?.url.href).toBe(`${SHEETS}?fields=sheets.properties`);
});

test("adding a tab and writing cells are confirmed in plain words, then sent", async () => {
  const fake = setup({ info: { name: "Rutiner" } });
  const add = {
    method: "POST",
    path: `${SHEETS}:batchUpdate`,
    body: { requests: [{ addSheet: { properties: { title: "rutiner 2026" } } }] },
  };
  expect(await fake.callTool("google_docs_api", add)).toStartWith("200");
  const card = fake.confirms[0];
  expect(card?.summary).toBe('Add a tab "rutiner 2026" to the spreadsheet "Rutiner".');
  expectPlainCard(card, [`POST ${SHEETS}:batchUpdate`, '"addSheet"']);
  expect(fake.writes()[0]?.url.href).toBe(`${SHEETS}:batchUpdate`);

  const rows = Array.from({ length: 8 }, () => ["a", "b", "c", "d", "e"]);
  const put = await fake.callTool("google_docs_api", {
    method: "PUT",
    path: `${SHEETS}/values/${encodeURIComponent("'rutiner 2026'!A1:E8")}`,
    query: { valueInputOption: "USER_ENTERED" },
    body: { values: rows },
  });
  expect(put).toStartWith("200");
  expect(fake.confirms[1]?.summary).toBe(
    `Write 8 rows into 'rutiner 2026'!A1:E8 in the spreadsheet "Rutiner".`,
  );
  expect(fake.confirms[1]?.details).toContain("valueInputOption=USER_ENTERED");
  expect(fake.writes()).toHaveLength(2);

  await fake.callTool("google_docs_api", {
    method: "POST",
    path: `${SHEETS}/values/Sheet1!A1:append`,
    body: { values: [["x"]] },
  });
  expect(fake.confirms[2]?.summary).toBe(
    'Append 1 row after Sheet1!A1 in the spreadsheet "Rutiner".',
  );
  await fake.callTool("google_docs_api", {
    method: "POST",
    path: `${SHEETS}:batchUpdate`,
    body: { requests: [{ updateCells: {} }, { appendCells: {} }] },
  });
  expect(fake.confirms[3]?.summary).toBe('Write cells in the spreadsheet "Rutiner".');
  await fake.callTool("google_docs_api", {
    method: "POST",
    path: `${SHEETS}/values/Sheet1!A1:E8:clear`,
    body: {},
  });
  expect(fake.confirms[4]?.summary).toBe('Clear Sheet1!A1:E8 in the spreadsheet "Rutiner".');
  await fake.callTool("google_docs_api", {
    method: "POST",
    path: `${SHEETS}/values/${encodeURIComponent("Sheet1!A1:append")}`,
    body: { values: [["x"]] },
  });
  expect(fake.confirms[5]?.summary).toBe(
    'Append 1 row after Sheet1!A1 in the spreadsheet "Rutiner".',
  );
  await fake.callTool("google_docs_api", {
    method: "POST",
    path: `${SHEETS}/values/Sheet1!A1:E8:batchWhatever`,
    body: {},
  });
  expect(fake.confirms[6]?.summary).toBe('Send a POST request to Google Sheets about "Rutiner".');
  await fake.callTool("google_docs_api", {
    method: "POST",
    path: `${SHEETS}:batchUpdate`,
    body: { requests: [{ deleteSheet: { sheetId: 1 } }] },
  });
  expect(fake.confirms[7]?.summary).toBe('Delete a tab in the spreadsheet "Rutiner".');
});

test("the docs tool finds Sheets methods in the Sheets discovery document", async () => {
  const sheets = {
    servicePath: "",
    resources: {
      spreadsheets: {
        methods: {
          batchUpdate: {
            id: "sheets.spreadsheets.batchUpdate",
            httpMethod: "POST",
            path: "v4/spreadsheets/{spreadsheetId}:batchUpdate",
          },
        },
        resources: {
          values: {
            methods: {
              update: {
                id: "sheets.spreadsheets.values.update",
                httpMethod: "PUT",
                path: "v4/spreadsheets/{spreadsheetId}/values/{range}",
              },
            },
          },
        },
      },
    },
  };
  const fetched: string[] = [];
  const tool = apiDocsTool(async (url) => {
    fetched.push(url);
    return Response.json(sheets);
  });
  const ctx = {
    session: "s",
    pick: async () => null,
    signal: new AbortController().signal,
    scratchpad: "/",
  };
  const found = await tool.call({ api: "sheets", query: "values update" }, ctx);
  expect(found).toContain(
    "sheets.spreadsheets.values.update  PUT /v4/spreadsheets/{spreadsheetId}/values/{range}",
  );
  expect(await tool.call({ api: "sheets", query: "batchUpdate" }, ctx)).toContain(
    "sheets.spreadsheets.batchUpdate  POST /v4/spreadsheets/{spreadsheetId}:batchUpdate",
  );
  expect(fetched).toEqual([DISCOVERY["sheets"] ?? ""]);
});

test("a Drive discovery path keeps its service path", () => {
  const drive = {
    servicePath: "drive/v3/",
    resources: {
      files: {
        methods: { get: { id: "drive.files.get", httpMethod: "GET", path: "files/{fileId}" } },
      },
    },
  };
  expect(searchDiscovery(drive, "")).toBe("drive.files.get  GET /drive/v3/files/{fileId}");
  expect(searchDiscovery(drive, "zzz")).toBe('Nothing in the API matches "zzz".');
});
