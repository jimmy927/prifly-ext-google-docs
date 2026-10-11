import { expect, test } from "bun:test";
import type { ExtensionApi } from "@prifly/extension-api";
import { askForDrive, connectionState, DRIVE_READONLY } from "../connection";
import { registerTools, relativeTime } from "../tools";
import { type FakeAccount, fakeApi, fakeConnections } from "./fake-api";
import { ACCOUNT, DOC_ID, type DriveData, fakeDrive } from "./fake-drive";

const EDIT_URL = `https://docs.google.com/document/d/${DOC_ID}/edit`;

/** Tools over a fake account; `signIns` counts calls to signIn, which no tool may make. */
function setup(data: DriveData = {}, accounts: FakeAccount[] = [{ ...ACCOUNT }]) {
  const drive = fakeDrive(data);
  const fake = fakeConnections({ accounts, provider: drive.provider });
  const signIns: unknown[][] = [];
  const signIn = fake.connections.signIn;
  fake.connections.signIn = (...args) => {
    signIns.push(args);
    return signIn(...args);
  };
  const api = fakeApi({ connections: fake.connections });
  registerTools(api.api);
  return { ...fake, ...api, urls: drive.urls, signIns };
}

const CALLS: [string, Record<string, unknown>][] = [
  ["google_docs_search", { query: "plan" }],
  ["google_docs_read", { doc: DOC_ID }],
  ["google_docs_comments", { doc: DOC_ID }],
];

test("the three tools are registered", () => {
  expect(
    setup()
      .tools()
      .map((tool) => tool.name),
  ).toEqual(["google_docs_search", "google_docs_read", "google_docs_comments"]);
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
  expect(await setup().callTool("google_docs_search", { query: "zzz" })).toBe(
    'No Docs matched "zzz".',
  );
});

test("read gives a title and link header, then the Markdown with pictures as placeholders", async () => {
  const markdown = "Hello ![](data:image/png;base64,AAAA)\n";
  const { callTool, urls } = setup({ markdown });
  const text = await callTool("google_docs_read", {
    doc: `https://docs.google.com/document/u/1/d/${DOC_ID}/edit`,
  });
  expect(text).toBe(`# Plan\n${EDIT_URL}\n\nHello [picture 1]`);
  const exported = urls.find((url) => url.pathname.endsWith("/export"));
  expect(exported?.pathname).toBe(`/drive/v3/files/${DOC_ID}/export`);
  expect(exported?.searchParams.get("mimeType")).toBe("text/markdown");
});

test("read cuts a long Doc and offset reads on", async () => {
  const { callTool } = setup({ markdown: `${"a".repeat(60_000)}${"b".repeat(10)}` });
  const first = await callTool("google_docs_read", { doc: DOC_ID });
  expect(first).toContain("with offset 60000 to read on");
  expect(await callTool("google_docs_read", { doc: DOC_ID, offset: 60_000 })).toEndWith(
    `\n\n${"b".repeat(10)}`,
  );
});

test("read and comments answer a link that is no Doc with a sentence", async () => {
  const { callTool, requests } = setup();
  for (const name of ["google_docs_read", "google_docs_comments"]) {
    expect(await callTool(name, { doc: "hello there" })).toContain(
      '"hello there" is not a Google Doc id',
    );
  }
  expect(requests).toHaveLength(0);
});

test("comments hide resolved ones by default and show them on request", async () => {
  const comments = [
    {
      id: "1",
      content: "Open one",
      author: { displayName: "Maryam" },
      quotedFileContent: { value: "line" },
    },
    { id: "2", content: "Closed one", resolved: true, author: { displayName: "Jimmy" } },
  ];
  const { callTool } = setup({ commentPages: [{ comments }, { comments }] });
  const open = await callTool("google_docs_comments", { doc: DOC_ID });
  expect(open).toContain("> line\n\n**Maryam**: Open one");
  expect(open).not.toContain("Closed one");
  const all = await callTool("google_docs_comments", { doc: DOC_ID, includeResolved: true });
  expect(all).toContain("Closed one");
  expect(await setup().callTool("google_docs_comments", { doc: DOC_ID })).toBe(
    "No open comments on this Doc.",
  );
});

test("a Doc Google does not know answers in one sentence", async () => {
  const { callTool } = setup({ always: 404 });
  expect(await callTool("google_docs_read", { doc: DOC_ID })).toBe(
    `No Doc with id ${DOC_ID} that this account can read.`,
  );
  expect(await setup({ always: 403 }).callTool("google_docs_search", {})).toBe(
    "Google answered 403: nope.",
  );
});

test("a busy Google is retried once, then reported", async () => {
  const busy = { status: 429, retryAfter: "0" };
  expect(await setup({ failWith: [busy] }).callTool("google_docs_comments", { doc: DOC_ID })).toBe(
    "No open comments on this Doc.",
  );
  expect(await setup({ failWith: [busy, busy] }).callTool("google_docs_search", {})).toBe(
    "Google is busy (429): try again in a minute.",
  );
});

test("every request carries the token of the connection", async () => {
  const { callTool, requests } = setup();
  for (const [name, args] of CALLS) await callTool(name, args);
  expect(requests.length).toBeGreaterThanOrEqual(4);
  for (const request of requests) {
    expect(request.headers.get("Authorization")).toMatch(/^Bearer token-g1-\d+$/);
  }
});

const NO_DRIVE: FakeAccount = { ...ACCOUNT, scopes: ["openid"] };

test("with no api.connections, no account, no Drive scope: each tool says what to do and never signs in", async () => {
  const none = setup({}, []);
  const scope = setup({}, [{ ...NO_DRIVE }]);
  const old = fakeApi();
  registerTools(old.api);
  for (const [name, args] of CALLS) {
    expect(await old.callTool(name, args)).toContain("update prifly");
    expect(await none.callTool(name, args)).toBe(
      "No Google account is connected: connect one in prifly's Vault → Connections.",
    );
    expect(await scope.callTool(name, args)).toBe(
      'maryam@example.com has not given prifly read access to Drive yet. Open "From a Google Doc…" in prifly, or connect it again with Drive access in Vault → Connections.',
    );
  }
  expect(none.signIns.concat(scope.signIns)).toEqual([]);
  expect(scope.requests).toHaveLength(0);
});

test("a grant Google ended answers with the sign-in text, listed or revoked mid-use, without signing in", async () => {
  const revoked = setup();
  revoked.endpoint.revoke("g1");
  // list() still says ok on a fresh view only if not revoked: the fake views the endpoint, so it says needs-sign-in.
  const text =
    "Google ended the sign-in for maryam@example.com: sign in again in prifly's Vault → Connections.";
  for (const [name, args] of CALLS) expect(await revoked.callTool(name, args)).toBe(text);
  expect(revoked.signIns).toEqual([]);

  const midUse = setup();
  const listed = midUse.connections.list;
  midUse.connections.list = (provider) =>
    listed(provider).map((each) => ({ ...each, state: "ok" as const }));
  midUse.endpoint.revoke("g1");
  for (const [name, args] of CALLS) expect(await midUse.callTool(name, args)).toBe(text);
  expect(midUse.signIns).toEqual([]);
});

test("the state prefers an ok connection with the scope, then the first", () => {
  const other: FakeAccount = { ...ACCOUNT, id: "g2", account: "second@example.com" };
  const api = (accounts: FakeAccount[]): ExtensionApi =>
    fakeApi({ connections: fakeConnections({ accounts }).connections }).api;
  const both = fakeConnections({ accounts: [{ ...ACCOUNT }, other] });
  both.endpoint.revoke("g1");
  const state = connectionState(fakeApi({ connections: both.connections }).api);
  expect(state.kind === "ok" && state.connection.id).toBe("g2");
  expect(connectionState(api([{ ...NO_DRIVE }, other])).kind).toBe("ok");
  expect(connectionState(api([{ ...NO_DRIVE }]))).toMatchObject({ kind: "scope-missing" });
});

test("askForDrive asks for drive.readonly on the connection", async () => {
  const { connections, accounts } = fakeConnections({ accounts: [{ ...NO_DRIVE }] });
  const api = fakeApi({ connections }).api;
  const state = connectionState(api);
  if (state.kind !== "scope-missing") throw new Error("expected scope-missing");
  const result = await askForDrive(api, state.connection);
  expect(result).toMatchObject({ ok: true, connection: "g1" });
  expect(accounts[0]?.scopes).toContain(DRIVE_READONLY);
});

test("relative times read like a person would say them", () => {
  const now = Date.parse("2026-10-11T12:00:00Z");
  expect(relativeTime("2026-10-11T11:59:50Z", now)).toBe("just now");
  expect(relativeTime("2026-10-11T11:15:00Z", now)).toBe("45 min ago");
  expect(relativeTime("2026-10-10T08:00:00Z", now)).toBe("yesterday");
  expect(relativeTime(null, now)).toBe("at an unknown time");
});
