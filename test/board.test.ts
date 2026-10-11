import { expect, test } from "bun:test";
import type { LaunchBoard, LaunchChoice } from "@prifly/extension-api";
import { choices, ROW } from "../board";
import { launch, launched } from "../launch";
import { docId, file, type Setup, settle, setup } from "./helpers";

function board(answer: LaunchChoice[] | LaunchBoard): LaunchBoard {
  if (Array.isArray(answer)) throw new Error(`expected a board, got ${JSON.stringify(answer)}`);
  return answer;
}

function list(answer: LaunchChoice[] | LaunchBoard): LaunchChoice[] {
  if (!Array.isArray(answer)) throw new Error("expected a plain list");
  return answer;
}

async function loaded(s: Setup, query = ""): Promise<LaunchBoard> {
  const answer = board(await choices(s.runtime, query));
  await s.runtime.cache.settled();
  return answer;
}

const A = docId(1);
const B = docId(2);
const C = docId(3);
const D = docId(4);

function threeLists() {
  return {
    starred: [file(A, "Alpha"), file(B, "Bravo")],
    recent: [file(B, "Bravo"), file(C, "Charlie")],
    shared: [
      file(C, "Charlie"),
      file(D, "Delta", {
        lastModifyingUser: { displayName: "Joe" },
        sharingUser: { displayName: "Sam" },
      }),
    ],
  };
}

test("the board has three columns and a Doc in several lists appears once, in the first", async () => {
  const s = setup(threeLists());
  const answer = await loaded(s);
  expect(answer.columns).toEqual([
    { id: "starred", name: "Starred" },
    { id: "recent", name: "Recent" },
    { id: "shared", name: "Shared with me" },
  ]);
  expect(answer.items.map((each) => [each.title, each.group])).toEqual([
    ["Alpha", "starred"],
    ["Bravo", "starred"],
    ["Charlie", "recent"],
    ["Delta", "shared"],
  ]);
});

test("a card says who edited it and when; a shared one who shared it; people are deduped", async () => {
  const s = setup(threeLists());
  const items = (await loaded(s)).items;
  const [alpha, , , delta] = items;
  expect(alpha?.detail).toBe("Edited by Maryam · 2 h ago");
  expect(alpha?.people).toEqual(["Maryam"]);
  expect(alpha?.url).toBe(`https://docs.google.com/document/d/${A}/edit`);
  expect(alpha?.key).toBe(A);
  expect(delta?.detail).toBe("Shared by Sam · 2 h ago");
  expect(delta?.people).toEqual(["Joe", "Maryam"]);
});

test("each column asks Drive for 25 Docs with the right filter and order", async () => {
  const s = setup(threeLists());
  await loaded(s);
  const lists = s.urls.filter((url) => url.pathname.endsWith("/files"));
  expect(lists).toHaveLength(3);
  for (const url of lists) {
    expect(url.searchParams.get("pageSize")).toBe("25");
    expect(url.searchParams.get("includeItemsFromAllDrives")).toBe("true");
    expect(url.searchParams.get("supportsAllDrives")).toBe("true");
    expect(url.searchParams.get("q")).toContain("mimeType='application/vnd.google-apps.document'");
    const fields = url.searchParams.get("fields") ?? "";
    for (const wanted of [
      "lastModifyingUser/displayName",
      "owners/displayName",
      "sharingUser/displayName",
      "modifiedTime",
      "webViewLink",
    ]) {
      expect(fields).toContain(wanted);
    }
  }
  const [starred, recent, shared] = lists;
  expect(starred?.searchParams.get("q")).toContain("starred=true");
  expect(recent?.searchParams.get("orderBy")).toBe("viewedByMeTime desc");
  expect(shared?.searchParams.get("q")).toContain("sharedWithMe=true");
  expect(shared?.searchParams.get("orderBy")).toBe("sharedWithMeTime desc");
});

test("typing answers from the cache without another request, filtering by title", async () => {
  const s = setup(threeLists());
  await loaded(s);
  const before = s.urls.length;
  const some = board(await choices(s.runtime, "br"));
  expect(some.items.map((each) => each.title)).toEqual(["Bravo"]);
  board(await choices(s.runtime, "brav"));
  board(await choices(s.runtime, ""));
  expect(s.urls.length).toBe(before);
});

test("a burst of keystrokes runs one Drive search, after 400 ms, answered next time", async () => {
  const s = setup({ ...threeLists(), searchFiles: [file(docId(9), "Zebra plan")] });
  await loaded(s);
  for (const query of ["z", "ze", "zeb"]) await choices(s.runtime, query);
  expect(s.timers.pending()).toEqual([400]);
  s.timers.fire();
  await settle();
  const searches = s.urls.filter((url) => url.searchParams.get("q")?.includes("fullText"));
  expect(searches).toHaveLength(1);
  const answer = board(await choices(s.runtime, "zeb"));
  expect(answer.items.map((each) => [each.title, each.group])).toEqual([["Zebra plan", "search"]]);
  expect(answer.columns.at(-1)).toEqual({ id: "search", name: "Search results" });
  // The same query again is cached: no new search is scheduled.
  expect(s.timers.pending()).toEqual([]);
});

test("only the last 10 searches are kept", async () => {
  const s = setup({ ...threeLists(), searchFiles: [] });
  await loaded(s);
  for (let n = 0; n < 12; n++) {
    await choices(s.runtime, `query${n}`);
    s.timers.fire();
    await settle();
  }
  expect(s.runtime.cache.searched("query0")).toBeUndefined();
  expect(s.runtime.cache.searched("query1")).toBeUndefined();
  expect(s.runtime.cache.searched("query2")).toEqual([]);
  expect(s.runtime.cache.searched("query11")).toEqual([]);
});

test("open comments badge the first 25 cards, six requests at a time", async () => {
  const all = Array.from({ length: 30 }, (_, n) => file(docId(n), `Doc ${n}`));
  const commentsByDoc: Record<string, unknown[]> = {};
  for (const each of all) {
    commentsByDoc[each.id] = [
      { id: "c1", content: "open", resolved: false },
      { id: "c2", content: "done", resolved: true },
    ];
  }
  const s = setup({
    starred: all.slice(0, 10),
    recent: all.slice(10, 20),
    shared: all.slice(20),
    commentsByDoc,
  });
  const answer = await loaded(s);
  const asked = s.urls.filter((url) => url.pathname.endsWith("/comments"));
  expect(asked).toHaveLength(25);
  expect(s.concurrency()).toBeGreaterThan(1);
  expect(s.concurrency()).toBeLessThanOrEqual(6);
  const next = board(await choices(s.runtime, ""));
  expect(answer.items).toHaveLength(30);
  expect(next.items.slice(0, 25).every((each) => each.badges?.comments === 1)).toBe(true);
  expect(next.items.slice(25).every((each) => each.badges === undefined)).toBe(true);
});

test("while the first fill runs the reader sees a loading row, then the board", async () => {
  const open = Promise.withResolvers<void>();
  const s = setup({ ...threeLists(), gate: open.promise });
  const waiting = choices(s.runtime, "");
  s.timers.fire();
  expect(list(await waiting).map((each) => each.title)).toEqual(["Loading your Docs…"]);
  open.resolve();
  await s.runtime.cache.settled();
  expect(board(await choices(s.runtime, "")).items).toHaveLength(4);
});

test("with no Google account the board is one row, and its launch says where to connect", async () => {
  const s = setup({}, { accounts: [] });
  const rows = list(await choices(s.runtime, ""));
  expect(rows.map((each) => each.title)).toEqual([
    "Connect a Google account in prifly's Vault → Connections",
  ]);
  const result = await launch(s.runtime, rows[0]?.key ?? "", "");
  expect(result.prompt).toBe("");
  expect(result.message).toContain("Vault → Connections");
});

test("without Drive access the row offers it, signs in with drive.readonly, then the board loads", async () => {
  const s = setup(threeLists(), {
    accounts: [{ id: "g1", provider: "google", account: "maryam@example.com", scopes: [] }],
  });
  const rows = list(await choices(s.runtime, ""));
  expect(rows.map((each) => each.title)).toEqual([
    "Give prifly read access to your Drive (maryam@example.com)",
  ]);
  const result = await launch(s.runtime, rows[0]?.key ?? "", "");
  expect(result.prompt).toBe("");
  expect(result.message).toContain("maryam@example.com");
  expect(s.signIns).toEqual([
    ["google", ["https://www.googleapis.com/auth/drive.readonly"], { connection: "g1" }],
  ]);
  expect(board(await choices(s.runtime, "")).items).toHaveLength(4);
});

test("a refused Drive grant is said, and the row stays", async () => {
  const s = setup(
    {},
    { accounts: [{ id: "g1", provider: "google", account: "a@example.com", scopes: [] }] },
  );
  s.connections.signIn = async () => ({ ok: false, message: "closed the window" });
  const result = await launch(s.runtime, ROW.grant, "");
  expect(result.message).toContain("closed the window");
  expect(list(await choices(s.runtime, ""))[0]?.key).toBe(ROW.grant);
});

test("an ended sign-in shows 'Sign in again', and signing in brings the board back", async () => {
  const s = setup(threeLists());
  s.endpoint.revoke("g1");
  const rows = list(await choices(s.runtime, ""));
  expect(rows.map((each) => each.title)).toEqual(["Sign in again as maryam@example.com"]);
  const result = await launch(s.runtime, rows[0]?.key ?? "", "");
  expect(result.prompt).toBe("");
  expect(s.endpoint.isEnded("g1")).toBe(false);
  expect(board(await choices(s.runtime, "")).items).toHaveLength(4);
});

test("a needsSignIn answer in the middle of a fetch gives the same row", async () => {
  const s = setup(threeLists());
  s.connections.fetch = async () => ({
    needsSignIn: { connection: "g1", provider: "google", account: "maryam@example.com" },
  });
  const rows = list(await choices(s.runtime, ""));
  expect(rows.map((each) => each.title)).toEqual(["Sign in again as maryam@example.com"]);
});

test("a Drive error is a row with the sentence; the cache is kept when there is one", async () => {
  const s = setup({ always: 500 });
  const rows = list(await choices(s.runtime, ""));
  expect(rows[0]?.title).toBe("Google answered 500: nope.");

  const ok = setup(threeLists());
  await loaded(ok);
  ok.connections.fetch = async () => new Response("{}", { status: 500 });
  ok.runtime.cache.invalidate();
  const answer = board(await choices(ok.runtime, ""));
  await settle();
  const after = board(await choices(ok.runtime, ""));
  expect(answer.items).toHaveLength(4);
  expect(after.items).toHaveLength(4);
  expect(after.actions?.some((each) => each.key === ROW.error && each.title.includes("500"))).toBe(
    true,
  );
});

test("the setup rows: open by link always, switch account only with several accounts", async () => {
  const one = setup(threeLists());
  const actions = (await loaded(one)).actions ?? [];
  expect(actions.map((each) => each.title)).toEqual(["Open a Doc by its link…"]);
  expect(actions[0]?.input?.title).toBeString();
  expect(actions[0]?.input?.placeholder).toContain("docs.google.com");

  const two = setup(threeLists(), {
    accounts: [
      {
        id: "g1",
        provider: "google",
        account: "maryam@example.com",
        scopes: ["https://www.googleapis.com/auth/drive.readonly"],
      },
      {
        id: "g2",
        provider: "google",
        account: "second@example.com",
        scopes: ["https://www.googleapis.com/auth/drive.readonly"],
      },
    ],
  });
  const rows = (await loaded(two)).actions ?? [];
  expect(rows.map((each) => each.title)).toEqual([
    "Open a Doc by its link…",
    "maryam@example.com · Switch account…",
  ]);
  const result = await launch(two.runtime, ROW.switch, "");
  expect(result.prompt).toBe("");
  expect(result.message).toContain("second@example.com");
  expect(two.runtime.store.state.connection).toBe("g2");
  const next = (await loaded(two)).actions ?? [];
  expect(next[1]?.title).toBe("second@example.com · Switch account…");
});

test("a card is 'started' once a session was launched from it", async () => {
  const s = setup({ ...threeLists(), markdown: "# Alpha" });
  await loaded(s);
  const launchedFrom = await launch(s.runtime, A, "");
  expect(launchedFrom.prompt).toContain("# Plan");
  launched(s.runtime, A, "session-1");
  const items = board(await choices(s.runtime, "")).items;
  expect(items.find((each) => each.key === A)?.started).toBe(true);
  expect(items.find((each) => each.key === B)?.started).toBeUndefined();
});
