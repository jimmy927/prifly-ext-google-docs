import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { choices } from "../board";
import { launch, launched } from "../launch";
import { DISMISS, SEND_CHANGES } from "../watch";
import { DOC_ID, type DriveData } from "./fake-drive";
import { file, type Setup, settle, setup } from "./helpers";

const LAUNCHED_AT = "2026-10-11T09:00:00.000Z";
const NEWER = "2026-10-11T09:05:00.000Z";
const OLDER = "2026-10-11T08:00:00.000Z";
const MIME = "application/vnd.google-apps.document";

function change(fileId: string, modifiedTime: string, extra: Record<string, unknown> = {}) {
  return {
    fileId,
    removed: false,
    file: {
      name: "Plan",
      mimeType: MIME,
      modifiedTime,
      lastModifyingUser: { displayName: "Maryam" },
      ...extra,
    },
  };
}

/** A watcher with session-1 launched from DOC_ID at LAUNCHED_AT and the page token already stored. */
async function launchedSetup(changes: unknown[], extra: DriveData = {}) {
  const s = setup(
    {
      info: { name: "Plan", modifiedTime: LAUNCHED_AT },
      markdown: "Old text",
      changePages: [{ changes, newStartPageToken: "start-9" }],
      ...extra,
    },
    { sessions: ["session-1"] },
  );
  await launch(s.runtime, DOC_ID, "");
  launched(s.runtime, DOC_ID, "session-1");
  s.runtime.store.state.pageToken = "start-1";
  return s;
}

function lastChips(s: Setup) {
  return s.fake.shown.at(-1)?.bySession ?? {};
}

test("the first tick stores the start page token and asks for no changes", async () => {
  const s = setup();
  await s.watcher.tick();
  expect(s.runtime.store.state.pageToken).toBe("start-1");
  expect(s.urls.map((url) => url.pathname)).toEqual(["/drive/v3/changes/startPageToken"]);
  const onDisk: { pageToken: string } = JSON.parse(
    readFileSync(join(s.folder, "state.json"), "utf8"),
  );
  expect(onDisk.pageToken).toBe("start-1");
});

test("a later tick follows the pages and stores the new token", async () => {
  const s = setup({
    changePages: [
      { changes: [], nextPageToken: "page-2" },
      { changes: [], newStartPageToken: "start-7" },
    ],
  });
  s.runtime.store.state.pageToken = "start-1";
  await s.watcher.tick();
  const asked = s.urls.filter((url) => url.pathname.endsWith("/changes"));
  expect(asked.map((url) => url.searchParams.get("pageToken"))).toEqual(["start-1", "page-2"]);
  expect(asked[0]?.searchParams.get("includeItemsFromAllDrives")).toBe("true");
  expect(asked[0]?.searchParams.get("supportsAllDrives")).toBe("true");
  expect(asked[0]?.searchParams.get("fields")).toContain("changes(fileId,removed,file(");
  expect(s.runtime.store.state.pageToken).toBe("start-7");
});

test("an edit of a launched Doc puts an info chip on its session that only offers the changes", async () => {
  const s = await launchedSetup([change(DOC_ID, NEWER)]);
  await s.watcher.tick();
  const chip = lastChips(s)["session-1"]?.[0];
  expect(chip?.label).toMatch(/^Doc edited by Maryam · /);
  expect(chip?.tone).toBe("info");
  expect(chip?.actions?.map((each) => each.id)).toEqual([SEND_CHANGES, DISMISS]);
  expect(chip?.actions?.[0]?.label).toBe("Send the changes");
  expect(s.prompts).toEqual([]);
});

test("an edit not newer than the launch, or of another Doc, or a removal, shows nothing", async () => {
  const s = await launchedSetup([
    change(DOC_ID, OLDER),
    change("some-other-doc-0123456789", NEWER),
    { fileId: DOC_ID, removed: true },
  ]);
  await s.watcher.tick();
  expect(s.watcher.chipSessions()).toEqual([]);
  expect(s.fake.shown).toEqual([]);
});

test("'Send the changes' prompts the session with the new text, remembers the edit and clears the chip", async () => {
  const s = await launchedSetup([change(DOC_ID, NEWER)]);
  await s.watcher.tick();
  const say = await s.watcher.act("session-1", SEND_CHANGES);
  expect(say).toBe("Sent the changes to the session.");
  expect(s.prompts).toHaveLength(1);
  expect(s.prompts[0]?.session).toBe("session-1");
  expect(s.prompts[0]?.text).toContain("Old text");
  expect(s.prompts[0]?.text).toContain("Plan");
  expect(lastChips(s)).toEqual({});
  expect(s.watcher.chipSessions()).toEqual([]);
});

test("after sending, the edit that was sent does not come back as a chip", async () => {
  const again = { changes: [change(DOC_ID, NEWER)], newStartPageToken: "start-9" };
  const s = await launchedSetup([change(DOC_ID, NEWER)], {
    info: { name: "Plan", modifiedTime: NEWER },
    changePages: [again, again],
  });
  s.runtime.store.state.sessions["session-1"] = {
    docId: DOC_ID,
    title: "Plan",
    modifiedTime: LAUNCHED_AT,
  };
  await s.watcher.tick();
  await s.watcher.act("session-1", SEND_CHANGES);
  expect(s.runtime.store.state.sessions["session-1"]?.modifiedTime).toBe(NEWER);
  await s.watcher.tick();
  expect(s.watcher.chipSessions()).toEqual([]);
});

test("a session that cannot be reached keeps its chip", async () => {
  const s = await launchedSetup([change(DOC_ID, NEWER)]);
  await s.watcher.tick();
  s.fake.api.prompt = async () => ({ delivered: false });
  expect(await s.watcher.act("session-1", SEND_CHANGES)).toContain("chip stays");
  expect(s.watcher.chipSessions()).toEqual(["session-1"]);
});

test("'Dismiss' clears the chip without telling the session", async () => {
  const s = await launchedSetup([change(DOC_ID, NEWER)]);
  await s.watcher.tick();
  expect(await s.watcher.act("session-1", DISMISS)).toBe("Dismissed.");
  expect(s.watcher.chipSessions()).toEqual([]);
  expect(s.prompts).toEqual([]);
  expect(s.runtime.store.state.sessions["session-1"]?.modifiedTime).toBe(NEWER);
});

test("sessions that no longer exist are dropped from the state, chip and all", async () => {
  const s = await launchedSetup([change(DOC_ID, NEWER)]);
  await s.watcher.tick();
  expect(s.watcher.chipSessions()).toEqual(["session-1"]);
  s.alive.delete("session-1");
  await s.watcher.tick();
  expect(s.runtime.store.state.sessions).toEqual({});
  expect(s.watcher.chipSessions()).toEqual([]);
  expect(lastChips(s)).toEqual({});
  const onDisk: { sessions: object } = JSON.parse(
    readFileSync(join(s.folder, "state.json"), "utf8"),
  );
  expect(onDisk.sessions).toEqual({});
});

test("a change to a Doc on the board refreshes the board's cache", async () => {
  const s = setup({
    starred: [file(DOC_ID, "Plan")],
    changePages: [{ changes: [change(DOC_ID, NEWER)], newStartPageToken: "start-9" }],
  });
  await choices(s.runtime, "");
  await s.runtime.cache.settled();
  const lists = () => s.urls.filter((url) => url.pathname.endsWith("/files")).length;
  expect(lists()).toBe(3);
  s.runtime.store.state.pageToken = "start-1";
  await s.watcher.tick();
  await settle();
  expect(lists()).toBe(6);
});

test("a sign-in that ended pauses the watcher and logs once; it resumes when the sign-in is back", async () => {
  const s = await launchedSetup([change(DOC_ID, NEWER)]);
  s.endpoint.revoke("g1");
  const before = s.urls.length;
  await s.watcher.tick();
  await s.watcher.tick();
  expect(s.urls.length).toBe(before);
  expect(s.fake.logs.filter((each) => each.event === "watch-paused")).toHaveLength(1);
  s.endpoint.revive("g1");
  await s.watcher.tick();
  expect(s.fake.logs.filter((each) => each.event === "watch-resumed")).toHaveLength(1);
  expect(s.watcher.chipSessions()).toEqual(["session-1"]);
});

test("a needsSignIn answer in the middle of a poll pauses it too", async () => {
  const s = await launchedSetup([]);
  s.connections.fetch = async () => ({
    needsSignIn: { connection: "g1", provider: "google", account: "maryam@example.com" },
  });
  await s.watcher.tick();
  expect(s.fake.logs.map((each) => each.event)).toContain("watch-paused");
});

test("a page token Drive refuses starts over from now", async () => {
  const s = setup({ always: 400 });
  s.runtime.store.state.pageToken = "stale";
  await s.watcher.tick();
  expect(s.runtime.store.state.pageToken).toBeNull();
  expect(s.fake.logs.map((each) => each.event)).toContain("watch-token-reset");
});

test("start polls at once, then every refreshSeconds; a new setting applies; stop clears the timer", async () => {
  const s = setup({}, { settings: { refreshSeconds: 120 } });
  s.watcher.start();
  expect(s.timers.pending()).toEqual([0]);
  s.timers.fire();
  await settle();
  expect(s.timers.pending()).toEqual([120_000]);
  expect(s.runtime.store.state.pageToken).toBe("start-1");
  s.changeSettings({ refreshSeconds: 30 });
  expect(s.timers.pending()).toEqual([30_000]);
  s.timers.fire();
  await settle();
  expect(s.timers.pending()).toEqual([30_000]);
  s.watcher.stop();
  expect(s.timers.pending()).toEqual([]);
  s.timers.fire();
  await settle();
  expect(s.timers.pending()).toEqual([]);
});

test("a poll still running when stop is called does not schedule another", async () => {
  const open = Promise.withResolvers<void>();
  const s = setup({});
  const fetchNow = s.connections.fetch;
  s.connections.fetch = async (...args) => {
    await open.promise;
    return await fetchNow(...args);
  };
  s.runtime.store.state.pageToken = "start-1";
  s.watcher.start();
  s.timers.fire();
  s.watcher.stop();
  open.resolve();
  await settle();
  expect(s.timers.pending()).toEqual([]);
});

test("a rate limit keeps the page token; only a refused token starts over", async () => {
  const s = setup({ failWith: [{ status: 403 }] });
  s.runtime.store.state.pageToken = "start-1";
  await s.watcher.tick();
  expect(s.runtime.store.state.pageToken).toBe("start-1");
  expect(s.fake.logs.map((each) => each.event)).toContain("watch-failed");
});
