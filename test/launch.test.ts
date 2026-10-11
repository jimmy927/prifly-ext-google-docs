import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROW } from "../board";
import { launch, launched, open } from "../launch";
import { TEXT_CAP } from "../markdown";
import { StateStore } from "../state";
import { fakeApi } from "./fake-api";
import { DOC_ID } from "./fake-drive";
import { setup } from "./helpers";

const PNG = "iVBORw0KGgo=";
const EDIT = "2026-10-11T09:30:00.000Z";
const INFO = {
  name: "Q3 Roadmap!",
  modifiedTime: EDIT,
  lastModifyingUser: { displayName: "Maryam" },
  owners: [{ displayName: "Joe" }],
};
const COMMENTS = [
  {
    id: "c1",
    content: "Is this date firm?",
    resolved: false,
    createdTime: "2026-10-10T08:00:00Z",
    author: { displayName: "Joe" },
    quotedFileContent: { value: "ship in Q3" },
    replies: [{ content: "Yes", author: { displayName: "Maryam" } }],
  },
  { id: "c2", content: "Typo fixed", resolved: true, author: { displayName: "Sam" } },
];

function picture(n: number): string {
  return `![p${n}](data:image/png;base64,${PNG})`;
}

test("launch builds the prompt: title, link, editor, Markdown, open comments, what was typed", async () => {
  const s = setup({
    info: INFO,
    markdown: `Intro\n\n${picture(1)}\n\nEnd`,
    commentPages: [{ comments: COMMENTS }],
  });
  const result = await launch(s.runtime, DOC_ID, "focus on risks");
  expect(result.prompt).toContain("# Q3 Roadmap!");
  expect(result.prompt).toContain(`https://docs.google.com/document/d/${DOC_ID}/edit`);
  expect(result.prompt).toContain(`Last edited by Maryam at ${EDIT}`);
  expect(result.prompt).toContain("Intro\n\n[picture 1]\n\nEnd");
  expect(result.prompt).toContain("## Open comments");
  expect(result.prompt).toContain("Is this date firm?");
  expect(result.prompt).not.toContain("Typo fixed");
  expect(result.prompt.endsWith("The reader adds: focus on risks")).toBe(true);
  expect(result.name).toBe("q3-roadmap");
  expect(result.images).toEqual([{ mediaType: "image/png", data: PNG }]);
});

test("without typed input there is no 'reader adds' line, and no comments section when none are open", async () => {
  const s = setup({ info: INFO, markdown: "Body" });
  const result = await launch(s.runtime, DOC_ID, "  ");
  expect(result.prompt).not.toContain("The reader adds");
  expect(result.prompt).not.toContain("## Open comments");
  expect(result.images).toBeUndefined();
});

test("a long Doc is cut at 60 000 characters with the note to read on by the Doc id", async () => {
  const s = setup({ info: INFO, markdown: "x".repeat(TEXT_CAP + 5000) });
  const result = await launch(s.runtime, DOC_ID, "");
  expect(result.prompt).toContain("google_docs_read");
  expect(result.prompt).toContain(`offset ${TEXT_CAP}`);
  expect(result.prompt).toContain(DOC_ID);
  expect(result.prompt.length).toBeLessThan(TEXT_CAP + 1000);
});

test("at most 20 pictures go with the session", async () => {
  const markdown = Array.from({ length: 23 }, (_, n) => picture(n)).join("\n\n");
  const s = setup({ info: INFO, markdown });
  const result = await launch(s.runtime, DOC_ID, "");
  expect(result.images).toHaveLength(20);
  expect(result.prompt).toContain("[more pictures not shown]");
});

test("the link row starts from a pasted link, and a bad link says so without starting", async () => {
  const s = setup({ info: INFO, markdown: "Body" });
  const good = await launch(
    s.runtime,
    ROW.link,
    `https://docs.google.com/document/d/${DOC_ID}/edit?usp=sharing`,
  );
  expect(good.prompt).toContain("# Q3 Roadmap!");
  const bad = await launch(s.runtime, ROW.link, "https://example.com/nothing");
  expect(bad.prompt).toBe("");
  expect(bad.message).toContain("not a link to a Google Doc");
  launched(s.runtime, ROW.link, "session-link");
  expect(s.runtime.store.state.sessions["session-link"]?.docId).toBe(DOC_ID);
});

test("a Drive error while launching is said, not thrown", async () => {
  const s = setup({ always: 404 });
  const result = await launch(s.runtime, DOC_ID, "");
  expect(result.prompt).toBe("");
  expect(result.message).toContain("404");
});

test("open writes the Doc out: Markdown, pictures as files, open comments as notes, people", async () => {
  const s = setup({
    info: INFO,
    markdown: `Intro\n\n${picture(1)}`,
    commentPages: [{ comments: COMMENTS }],
  });
  const item = await open(s.runtime, DOC_ID);
  expect(item.title).toBe("Q3 Roadmap!");
  expect(item.url).toBe(`https://docs.google.com/document/d/${DOC_ID}/edit`);
  expect(item.people).toEqual(["Maryam", "Joe"]);
  expect(item.markdown).toBe("Intro\n\n[picture 1]");
  expect(item.files).toEqual([
    { id: "picture-1", name: "picture 1", data: `data:image/png;base64,${PNG}` },
  ]);
  expect(item.notes).toHaveLength(1);
  expect(item.notes?.[0]).toEqual({
    by: "Joe",
    at: "2026-10-10T08:00:00Z",
    text: "> ship in Q3\n\nIs this date firm?\n\n↳ **Maryam**: Yes",
  });
});

test("launched writes state.json, which reads back", async () => {
  const s = setup({ info: INFO, markdown: "Body" });
  await launch(s.runtime, DOC_ID, "");
  launched(s.runtime, DOC_ID, "session-1");
  const onDisk: unknown = JSON.parse(readFileSync(join(s.folder, "state.json"), "utf8"));
  expect(onDisk).toEqual({
    sessions: { "session-1": { docId: DOC_ID, title: "Q3 Roadmap!", modifiedTime: EDIT } },
    pageToken: null,
    connection: null,
  });
  const again = new StateStore(s.fake.api);
  expect(again.state.sessions["session-1"]?.docId).toBe(DOC_ID);
  expect(again.sessionsOf(DOC_ID)).toEqual(["session-1"]);
});

test("a broken state.json is an empty state, and is logged", () => {
  const folder = mkdtempSync(join(tmpdir(), "gdocs-"));
  writeFileSync(join(folder, "state.json"), "{ not json");
  const fake = fakeApi({ folder });
  const store = new StateStore(fake.api);
  expect(store.state).toEqual({ sessions: {}, pageToken: null, connection: null });
  expect(fake.logs.map((each) => each.event)).toEqual(["state-unreadable"]);
  store.save();
  expect(new StateStore(fake.api).state.sessions).toEqual({});
});

test("a state.json of the wrong shape keeps only what fits", () => {
  const folder = mkdtempSync(join(tmpdir(), "gdocs-"));
  writeFileSync(
    join(folder, "state.json"),
    JSON.stringify({
      sessions: { ok: { docId: "d" }, bad: { docId: 3 }, worse: "x" },
      pageToken: 5,
    }),
  );
  const store = new StateStore(fakeApi({ folder }).api);
  expect(store.state.sessions).toEqual({
    ok: { docId: "d", title: "(untitled)", modifiedTime: null },
  });
  expect(store.state.pageToken).toBeNull();
});
