import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    'api is "docs", "drive", "sheets", "slides" or "forms".',
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

const SLIDES = "https://slides.googleapis.com/v1/presentations/deck1";
const FORMS = "https://forms.googleapis.com/v1/forms/form1";

test("Slides and Forms GETs run at once, their batchUpdates wait for Confirm", async () => {
  const fake = setup({ info: { name: "Pitch" } });
  expect(await fake.callTool("google_docs_api", { path: SLIDES })).toStartWith("200");
  expect(await fake.callTool("google_docs_api", { path: FORMS })).toStartWith("200");
  expect(fake.confirms).toEqual([]);
  for (const url of [`${SLIDES}:batchUpdate`, `${FORMS}:batchUpdate`]) {
    fake.confirmAnswer.value = false;
    const args = { method: "POST", path: url, body: { requests: [] } };
    expect(await fake.callTool("google_docs_api", args)).toBe(CANCELLED);
    expect(fake.writes().some((each) => each.url.href === url)).toBe(false);
    fake.confirmAnswer.value = true;
    expect(await fake.callTool("google_docs_api", args)).toStartWith("200");
  }
  expect(fake.confirms).toHaveLength(4);
  expect(fake.writes().map((each) => each.url.href)).toEqual([
    `${SLIDES}:batchUpdate`,
    `${FORMS}:batchUpdate`,
  ]);
  expect(fake.confirms[0]?.details).toContain(`POST ${SLIDES}:batchUpdate`);
});

test("bare v1/ paths go to Slides or Forms for presentations and forms, otherwise Docs", () => {
  expect(String(resolveApiUrl("v1/presentations/x"))).toBe(
    "https://slides.googleapis.com/v1/presentations/x",
  );
  expect(String(resolveApiUrl("/v1/presentations/x:batchUpdate"))).toBe(
    "https://slides.googleapis.com/v1/presentations/x:batchUpdate",
  );
  expect(String(resolveApiUrl("v1/forms/x"))).toBe("https://forms.googleapis.com/v1/forms/x");
  expect(String(resolveApiUrl("v1/documents/x"))).toBe(
    "https://docs.googleapis.com/v1/documents/x",
  );
  expect(resolveApiUrl("https://slides.googleapis.com/v2/presentations/x")).toBeString();
  expect(resolveApiUrl("https://forms.googleapis.com/v2/forms/x")).toBeString();
  expect(resolveApiUrl("https://gmail.googleapis.com/v1/users/me")).toBeString();
});

test("the card names a presentation, a form or an uploaded file by its title", async () => {
  const dir = await mkdtemp(join(tmpdir(), "up-"));
  const file = join(dir, "a.txt");
  await writeFile(file, "hello");
  const fake = setup({ info: { name: "Pitch" } });
  const sends = [
    { method: "POST", path: `${SLIDES}:batchUpdate`, body: {} },
    { method: "POST", path: `${FORMS}:batchUpdate`, body: {} },
    {
      method: "PATCH",
      path: `https://www.googleapis.com/upload/drive/v3/files/${DOC_ID}?uploadType=media`,
      media_path: file,
    },
  ];
  for (const each of sends) await fake.callTool("google_docs_api", each);
  expect(fake.confirms).toHaveLength(3);
  for (const card of fake.confirms) expect(card.summary).toContain('"Pitch"');
  await rm(dir, { recursive: true });
});

test("a media upload sends the file's bytes with its content type after a card showing the file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "up-"));
  const file = join(dir, "notes.txt");
  await writeFile(file, "hello bytes");
  const fake = setup({ info: { name: "Notes" } });
  const path = `/upload/drive/v3/files/${DOC_ID}`;
  const args = { method: "PATCH", path, query: { uploadType: "media" }, media_path: file };
  fake.confirmAnswer.value = false;
  expect(await fake.callTool("google_docs_api", args)).toBe(CANCELLED);
  expect(fake.writes()).toEqual([]);
  fake.confirmAnswer.value = true;
  const answer = await fake.callTool("google_docs_api", { ...args, content_type: "text/plain" });
  expect(answer).toStartWith("200");
  const card = fake.confirms[1];
  expect(card?.content).toContain(`File: ${file}`);
  expect(card?.content).toContain("Size: 11 bytes");
  expect(card?.content).toContain("Content type: text/plain");
  expect(card?.details).toContain(file);
  const sent = fake.writes()[0];
  expect(sent?.url.href).toBe(
    `https://www.googleapis.com/upload/drive/v3/files/${DOC_ID}?uploadType=media`,
  );
  expect(sent?.body).toBe("hello bytes");
  expect(sent?.contentType).toBe("text/plain");
  await rm(dir, { recursive: true });
});

test("a multipart upload sends the metadata and the file as multipart/related", async () => {
  const dir = await mkdtemp(join(tmpdir(), "up-"));
  const file = join(dir, "notes.txt");
  await writeFile(file, "file text");
  const fake = setup();
  const answer = await fake.callTool("google_docs_api", {
    method: "POST",
    path: "upload/drive/v3/files?uploadType=multipart",
    body: { name: "Notes" },
    media_path: file,
    content_type: "text/plain",
  });
  expect(answer).toStartWith("200");
  const sent = fake.writes()[0];
  expect(sent?.contentType).toStartWith("multipart/related; boundary=");
  expect(sent?.body).toContain('{"name":"Notes"}');
  expect(sent?.body).toContain("Content-Type: text/plain\r\n\r\nfile text\r\n--");
  await rm(dir, { recursive: true });
});

test("uploads refuse resumable, a relative or missing file, and media_path on other URLs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "up-"));
  const file = join(dir, "a.txt");
  await writeFile(file, "x");
  const fake = setup();
  const up = "/upload/drive/v3/files";
  const calls: Record<string, unknown>[] = [
    { method: "POST", path: `${up}?uploadType=resumable`, media_path: file },
    { method: "POST", path: up, media_path: file },
    { method: "POST", path: `${up}?uploadType=media`, media_path: "a.txt" },
    { method: "POST", path: `${up}?uploadType=media` },
    { method: "POST", path: `${up}?uploadType=media`, media_path: join(dir, "missing") },
    { method: "PATCH", path: `${up}?uploadType=media`, media_path: file },
    { method: "POST", path: `${up}?uploadType=media`, media_path: dir },
    { method: "POST", path: "/drive/v3/files", media_path: file },
    { method: "POST", path: `${SLIDES}:batchUpdate`, media_path: file },
  ];
  for (const each of calls) {
    expect(await fake.callTool("google_docs_api", each)).toMatch(/^(Refused|Could not read)/);
  }
  expect(await fake.callTool("google_docs_api", calls[0] ?? {})).toContain("resumable");
  expect(fake.confirms).toEqual([]);
  expect(fake.sent).toEqual([]);
  await rm(dir, { recursive: true });
});
