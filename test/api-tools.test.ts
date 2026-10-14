import { expect, test } from "bun:test";
import { apiDocsTool, DISCOVERY, resolveApiUrl, searchDiscovery } from "../api-tools";
import { CANCELLED } from "../common";
import { DOC_ID } from "./fake-drive";
import { setup } from "./helpers";

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
  const fake = setup();
  const args = {
    method: "post",
    path: `https://docs.googleapis.com/v1/documents/${DOC_ID}:batchUpdate`,
    body: { requests: [] },
  };
  expect(await fake.callTool("google_docs_api", args)).toStartWith("200");
  expect(fake.confirms[0]?.details).toBe(
    `POST https://docs.googleapis.com/v1/documents/${DOC_ID}:batchUpdate\n\n{"requests":[]}`,
  );
  expect(fake.writes()[0]?.body).toBe('{"requests":[]}');
  fake.confirmAnswer.value = false;
  expect(await fake.callTool("google_docs_api", { ...args, method: "DELETE" })).toBe(CANCELLED);
  expect(fake.writes()).toHaveLength(1);
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
  expect(await tool.call({ api: "sheets", query: "" }, ctx)).toBe('api is "docs" or "drive".');
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
