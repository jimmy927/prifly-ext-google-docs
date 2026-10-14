import { expect, test } from "bun:test";
import type { ExtensionApi } from "@prifly/extension-api";
import { CANCELLED, NO_CONFIRM } from "../common";
import { askForAccess, connectionState, DOCS_SCOPE, DRIVE_SCOPE } from "../connection";
import { registerTools, relativeTime } from "../tools";
import { type FakeAccount, fakeApi, fakeConnections } from "./fake-api";
import { ACCOUNT, DOC_ID, documentOf } from "./fake-drive";
import { setup } from "./helpers";

const EDIT_URL = `https://docs.google.com/document/d/${DOC_ID}/edit`;

const READS: [string, Record<string, unknown>][] = [
  ["google_docs_search", { query: "plan" }],
  ["google_docs_read", { doc: DOC_ID }],
  ["google_docs_read_structure", { doc: DOC_ID }],
  ["google_docs_comments", { doc: DOC_ID }],
];

const DOC = documentOf([
  { text: "Intro\n", style: "HEADING_1" },
  { text: "Hello world\n" },
  { text: "Item\n", list: "kix.list1" },
]);

test("the tools are registered", () => {
  expect(
    setup()
      .tools()
      .map((tool) => tool.name),
  ).toEqual([
    "google_docs_search",
    "google_docs_read",
    "google_docs_read_structure",
    "google_docs_comments",
    "google_docs_create",
    "google_docs_edit",
    "google_docs_comment_reply",
    "google_docs_comment_resolve",
    "google_docs_api",
    "google_docs_api_docs",
    "google_docs_sign_in",
  ]);
});

test("search lists title, id, editor, time and link", async () => {
  const modified = new Date(Date.now() - 3 * 3_600_000).toISOString();
  const { callTool, urls } = setup({
    files: [
      {
        id: DOC_ID,
        name: "Q3 plan",
        modifiedTime: modified,
        lastModifyingUser: { displayName: "Maryam" },
        webViewLink: EDIT_URL,
      },
    ],
  });
  const text = await callTool("google_docs_search", { query: "Bob's plan", limit: 5 });
  expect(text).toBe(
    `1. Q3 plan\n   Doc id: ${DOC_ID} · edited by Maryam · 3 h ago\n   ${EDIT_URL}`,
  );
  expect(urls[0]?.searchParams.get("q")).toContain("fullText contains 'Bob\\'s plan'");
});

test("read gives a title and link header, then the Markdown with pictures as placeholders", async () => {
  const { callTool } = setup({ markdown: "Hello ![](data:image/png;base64,AAAA)\n" });
  const text = await callTool("google_docs_read", {
    doc: `https://docs.google.com/document/u/1/d/${DOC_ID}/edit`,
  });
  expect(text).toBe(`# Plan\n${EDIT_URL}\n\nHello [picture 1]`);
});

test("read_structure shows each paragraph's indexes, style and list, and the revisionId", async () => {
  const text = await setup({ documents: [DOC] }).callTool("google_docs_read_structure", {
    doc: DOC_ID,
  });
  expect(text).toContain("revisionId: rev-1");
  expect(text).toContain('1–7 · HEADING_1 "Intro"');
  expect(text).toContain('7–19 · NORMAL_TEXT "Hello world"');
  expect(text).toContain('19–24 · NORMAL_TEXT · list kix.list1 level 0 "Item"');
});

test("comments show each comment's id for a reply", async () => {
  const comments = [{ id: "c1", content: "Open one", author: { displayName: "Maryam" } }];
  const text = await setup({ commentPages: [{ comments }] }).callTool("google_docs_comments", {
    doc: DOC_ID,
  });
  expect(text).toContain("**Maryam**: Open one\n(comment id: c1)");
});

test("reads run at once: no confirm card", async () => {
  const fake = setup({ documents: [DOC] });
  for (const [name, args] of READS) await fake.callTool(name, args);
  expect(fake.confirms).toEqual([]);
  expect(fake.writes()).toEqual([]);
});

// --- Edit --------------------------------------------------------------

const EDIT = {
  doc: DOC_ID,
  revisionId: "rev-1",
  operations: [
    { type: "insert", text: "New. ", index: 7 },
    { type: "replace_text", find: "world", replace: "there" },
  ],
};

test("an edit is confirmed with the exact change, then sent as one batchUpdate held to the revision", async () => {
  const fake = setup({ documents: [DOC] });
  const answer = await fake.callTool("google_docs_edit", EDIT);
  expect(answer).toContain('Done: "Plan" changed in place (2 changes). New revisionId: rev-after.');
  expect(fake.confirms).toHaveLength(1);
  const card = fake.confirms[0];
  expect(card?.summary).toBe('Change "Plan" in place (2 changes)');
  expect(card?.details).toContain(`Doc: Plan (${DOC_ID})`);
  expect(card?.details).toContain("1. Insert at index 7:\n    New. ");
  expect(card?.details).toContain(
    '2. Replace every "world" (1 found, matching case) with:\n    there',
  );
  expect(card?.details).toContain(
    `POST https://docs.googleapis.com/v1/documents/${DOC_ID}:batchUpdate`,
  );
  const [write] = fake.writes();
  expect(fake.writes()).toHaveLength(1);
  expect(write?.url.pathname).toBe(`/v1/documents/${DOC_ID}:batchUpdate`);
  const body = JSON.parse(write?.body ?? "{}");
  expect(body.writeControl).toEqual({ requiredRevisionId: "rev-1" });
  expect(body.requests).toHaveLength(2);
});

test("a cancelled edit sends nothing", async () => {
  const fake = setup({ documents: [DOC] });
  fake.confirmAnswer.value = false;
  expect(await fake.callTool("google_docs_edit", EDIT)).toBe(CANCELLED);
  expect(fake.writes()).toEqual([]);
});

test("a Doc changed since the read is caught before the card and nothing is sent", async () => {
  const fake = setup({ documents: [documentOf([{ text: "Hello world\n" }], "rev-2")] });
  const answer = await fake.callTool("google_docs_edit", EDIT);
  expect(answer).toContain("changed since your read");
  expect(answer).toContain("it is now rev-2");
  expect(answer).toContain("google_docs_read_structure again");
  expect(fake.confirms).toEqual([]);
  expect(fake.writes()).toEqual([]);
});

test("a revision conflict from Google re-reads the Doc and asks for a rebuilt edit, never a copy", async () => {
  const changed = documentOf([{ text: "Hello world\n" }], "rev-2");
  const fake = setup({ documents: [DOC, changed], conflict: true });
  const answer = await fake.callTool("google_docs_edit", EDIT);
  expect(answer).toBe(
    'Not done: the Doc "Plan" changed since your read (revisionId rev-1 is no longer current; it is now rev-2). Nothing was changed. Call google_docs_read_structure again, rebuild the edit against the new indexes and send it with revisionId rev-2. Never create a new Doc instead.',
  );
  // One batchUpdate, then a fresh read: no upload, no second write.
  expect(fake.writes().map((each) => each.url.pathname)).toEqual([
    `/v1/documents/${DOC_ID}:batchUpdate`,
  ]);
  expect(fake.sent.at(-1)?.url.pathname).toBe(`/v1/documents/${DOC_ID}`);
});

test("an edit without a revisionId or with bad operations sends nothing", async () => {
  const fake = setup({ documents: [DOC] });
  expect(await fake.callTool("google_docs_edit", { ...EDIT, revisionId: "" })).toContain(
    "pass the revisionId",
  );
  expect(
    await fake.callTool("google_docs_edit", { ...EDIT, operations: [{ type: "insert" }] }),
  ).toBe("Not done: Operation 1: insert needs a non-empty text.");
  expect(fake.sent).toEqual([]);
});

// --- Create and comments -----------------------------------------------

test("create is confirmed with the Markdown, then uploaded as a Doc", async () => {
  const fake = setup();
  const answer = await fake.callTool("google_docs_create", { title: "Notes", markdown: "# Hi\n" });
  expect(answer).toBe(
    'Created "New".\nDoc id: new-doc-id-12345\nhttps://docs.google.com/document/d/new-doc-id-12345/edit',
  );
  expect(fake.confirms[0]?.details).toContain("Title: Notes\n\n# Hi\n");
  const [upload] = fake.writes();
  expect(upload?.url.pathname).toBe("/upload/drive/v3/files");
  expect(upload?.url.searchParams.get("uploadType")).toBe("multipart");
  expect(upload?.contentType).toStartWith("multipart/related; boundary=");
  expect(upload?.body).toContain('"mimeType":"application/vnd.google-apps.document"');
  expect(upload?.body).toContain("Content-Type: text/markdown");
});

test("reply and resolve are confirmed with the comment, then posted as Drive replies", async () => {
  const fake = setup();
  const replied = await fake.callTool("google_docs_comment_reply", {
    doc: DOC_ID,
    commentId: "c1",
    text: "Done",
  });
  expect(replied).toBe('Replied to Maryam\'s comment on "Plan".');
  expect(fake.confirms[0]?.details).toContain("Maryam wrote: Please fix");
  const resolved = await fake.callTool("google_docs_comment_resolve", {
    doc: DOC_ID,
    commentId: "c1",
  });
  expect(resolved).toBe('Resolved Maryam\'s comment on "Plan".');
  const [reply, resolve] = fake.writes();
  expect(reply?.url.pathname).toBe(`/drive/v3/files/${DOC_ID}/comments/c1/replies`);
  expect(JSON.parse(reply?.body ?? "")).toEqual({ content: "Done" });
  expect(JSON.parse(resolve?.body ?? "")).toEqual({ content: "", action: "resolve" });
});

const WRITES: [string, Record<string, unknown>][] = [
  ["google_docs_edit", EDIT],
  ["google_docs_create", { title: "Notes", markdown: "x" }],
  ["google_docs_comment_reply", { doc: DOC_ID, commentId: "c1", text: "ok" }],
  ["google_docs_comment_resolve", { doc: DOC_ID, commentId: "c1" }],
  ["google_docs_api", { method: "POST", path: `/v1/documents/${DOC_ID}:batchUpdate`, body: {} }],
];

test("every write asks first; cancelled, none sends a request", async () => {
  for (const [name, args] of WRITES) {
    const fake = setup({ documents: [DOC] });
    fake.confirmAnswer.value = false;
    expect(await fake.callTool(name, args)).toBe(CANCELLED);
    expect(fake.confirms).toHaveLength(1);
    expect(fake.writes()).toEqual([]);
  }
});

test("on a prifly that cannot confirm, no write is sent", async () => {
  for (const [name, args] of WRITES) {
    const fake = setup({ documents: [DOC] }, [{ ...ACCOUNT }], { confirm: false });
    expect(await fake.callTool(name, args)).toBe(NO_CONFIRM);
    expect(fake.writes()).toEqual([]);
  }
});

// --- Accounts ----------------------------------------------------------

const READ_ONLY: FakeAccount = {
  ...ACCOUNT,
  scopes: ["https://www.googleapis.com/auth/drive.readonly"],
};

test("with no api.connections, no account, or only the old read-only scope: each tool says what to do", async () => {
  const none = setup({}, []);
  const scope = setup({}, [{ ...READ_ONLY }]);
  const old = fakeApi();
  registerTools(old.api);
  for (const [name, args] of [...READS, ...WRITES]) {
    expect(await old.callTool(name, args)).toContain("update prifly");
    expect(await none.callTool(name, args)).toContain("No Google account is connected");
    expect(await scope.callTool(name, args)).toContain(
      "maryam@example.com has not given prifly access to read and edit Google Docs yet",
    );
  }
  expect(none.signIns.concat(scope.signIns)).toEqual([]);
  expect(scope.requests).toHaveLength(0);
});

test("a grant Google ended answers with the sign-in text", async () => {
  const revoked = setup();
  revoked.endpoint.revoke("g1");
  const text =
    "Google ended the sign-in for maryam@example.com: sign in again in prifly's Vault → Connections.";
  for (const [name, args] of READS) expect(await revoked.callTool(name, args)).toBe(text);
});

test("the sign-in tool asks for Docs and Drive on the account that lacks them", async () => {
  const fake = setup({}, [{ ...READ_ONLY }]);
  expect(await fake.callTool("google_docs_sign_in", {})).toBe(
    "Connected as maryam@example.com with access to read and edit Google Docs.",
  );
  expect(fake.signIns).toEqual([["google", [DOCS_SCOPE, DRIVE_SCOPE], { connection: "g1" }]]);
  expect(await fake.callTool("google_docs_sign_in", {})).toContain("Already connected");
});

test("the state wants both scopes on an ok connection", async () => {
  const api = (accounts: FakeAccount[]): ExtensionApi =>
    fakeApi({ connections: fakeConnections({ accounts }).connections }).api;
  const other: FakeAccount = { ...ACCOUNT, id: "g2", account: "second@example.com" };
  const state = connectionState(api([{ ...READ_ONLY }, other]));
  expect(state.kind === "ok" && state.connection.id).toBe("g2");
  expect(connectionState(api([{ ...READ_ONLY }])).kind).toBe("scope-missing");
  const { connections, accounts } = fakeConnections({ accounts: [{ ...READ_ONLY }] });
  const result = await askForAccess(fakeApi({ connections }).api, connections.list("google")[0]);
  expect(result).toMatchObject({ ok: true });
  expect(accounts[0]?.scopes).toEqual(expect.arrayContaining([DOCS_SCOPE, DRIVE_SCOPE]));
});

test("relative times read like a person would say them", () => {
  const now = Date.parse("2026-10-11T12:00:00Z");
  expect(relativeTime("2026-10-11T11:59:50Z", now)).toBe("just now");
  expect(relativeTime("2026-10-10T08:00:00Z", now)).toBe("yesterday");
});
