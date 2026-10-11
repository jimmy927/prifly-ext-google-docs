import { expect, test } from "bun:test";
import {
  buildSearchQuery,
  DriveHttpError,
  DriveSignInError,
  docInfo,
  listComments,
  parseDocId,
  searchDocs,
} from "../drive";
import { fakeConnections } from "./fake-api";
import { ACCOUNT, DOC_ID, type DriveData, fakeDrive } from "./fake-drive";

const signal = new AbortController().signal;

function setup(data: DriveData = {}) {
  const drive = fakeDrive(data);
  const fake = fakeConnections({ accounts: [{ ...ACCOUNT }], provider: drive.provider });
  const handle = { fetch: (url: string) => fake.connections.fetch("g1", url) };
  return { ...fake, urls: drive.urls, handle };
}

test("a search holds Docs only and escapes quotes and backslashes", () => {
  const q = buildSearchQuery(String.raw`Bob's \ plan`);
  expect(q).toBe(
    String.raw`mimeType='application/vnd.google-apps.document' and trashed=false and (fullText contains 'Bob\'s \\ plan' or name contains 'Bob\'s \\ plan')`,
  );
  expect(buildSearchQuery("  ")).toBe(
    "mimeType='application/vnd.google-apps.document' and trashed=false",
  );
});

test("a search sends all-drives flags, no orderBy with text, and orders an empty query by recency", async () => {
  const { handle, urls } = setup();
  await searchDocs(handle, "plan", 10, signal);
  await searchDocs(handle, "", 99, signal);
  const [withText, recent] = urls;
  expect(withText?.searchParams.get("orderBy")).toBeNull();
  expect(withText?.searchParams.get("corpora")).toBe("allDrives");
  expect(withText?.searchParams.get("includeItemsFromAllDrives")).toBe("true");
  expect(withText?.searchParams.get("supportsAllDrives")).toBe("true");
  expect(withText?.searchParams.get("pageSize")).toBe("10");
  expect(recent?.searchParams.get("orderBy")).toBe("modifiedTime desc");
  expect(recent?.searchParams.get("pageSize")).toBe("50");
});

test("a search reads the files and falls back to the owner when no one else edited", async () => {
  const { handle } = setup({
    files: [{ id: "a", name: "A", owners: [{ displayName: "Owner" }] }, { nope: true }],
    nextPageToken: "more",
  });
  const { docs, more } = await searchDocs(handle, "", 20, signal);
  expect(more).toBe(true);
  expect(docs).toEqual([
    {
      id: "a",
      name: "A",
      modifiedTime: null,
      modifiedBy: "Owner",
      link: "https://docs.google.com/document/d/a/edit",
    },
  ]);
});

test("a Doc id comes out of an id, an edit link, a /u/1/ link, and nothing else", () => {
  expect(parseDocId(DOC_ID)).toBe(DOC_ID);
  expect(parseDocId(`https://docs.google.com/document/d/${DOC_ID}/edit?tab=t.0`)).toBe(DOC_ID);
  expect(parseDocId(`https://docs.google.com/document/u/1/d/${DOC_ID}/edit`)).toBe(DOC_ID);
  expect(parseDocId(`  ${DOC_ID}\n`)).toBe(DOC_ID);
  expect(parseDocId("not a doc")).toBeNull();
  expect(parseDocId(`https://example.com/document/d/${DOC_ID}`)).toBeNull();
  expect(parseDocId(`https://docs.google.com/spreadsheets/d/${DOC_ID}`)).toBeNull();
});

test("comments follow the pages and stop after five", async () => {
  const page = (n: number) => ({ comments: [{ id: `c${n}` }], nextPageToken: `t${n}` });
  const { handle, urls } = setup({ commentPages: [1, 2, 3, 4, 5, 6, 7].map(page) });
  const comments = await listComments(handle, DOC_ID, signal);
  expect(comments.map((each) => each.id)).toEqual(["c1", "c2", "c3", "c4", "c5"]);
  expect(urls[1]?.searchParams.get("pageToken")).toBe("t1");
  expect(urls[0]?.searchParams.get("includeDeleted")).toBe("false");
});

test("429 waits Retry-After and goes once more, then reports", async () => {
  const once = setup({ failWith: [{ status: 429, retryAfter: "0" }] });
  expect((await docInfo(once.handle, DOC_ID, signal)).name).toBe("Plan");
  expect(once.requests).toHaveLength(2);

  const busy = { status: 503, retryAfter: "0" };
  const twice = setup({ failWith: [busy, busy] });
  const error = await docInfo(twice.handle, DOC_ID, signal).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(DriveHttpError);
  expect((error as DriveHttpError).status).toBe(503);
  expect(twice.requests).toHaveLength(2);
});

test("a non-2xx answer becomes a DriveHttpError with Google's message", async () => {
  const { handle } = setup({ always: 404 });
  const error = await docInfo(handle, DOC_ID, signal).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(DriveHttpError);
  expect((error as DriveHttpError).detail).toBe("nope");
});

test("a revoked grant becomes a DriveSignInError naming the account", async () => {
  const { handle, endpoint } = setup();
  endpoint.revoke("g1");
  const error = await docInfo(handle, DOC_ID, signal).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(DriveSignInError);
  expect((error as DriveSignInError).account).toBe("maryam@example.com");
});

test("every request carries the fake endpoint's token", async () => {
  const { handle, requests } = setup({
    commentPages: [{ comments: [], nextPageToken: "x" }, { comments: [] }],
  });
  await listComments(handle, DOC_ID, signal);
  await docInfo(handle, DOC_ID, signal);
  expect(requests.map((each) => each.headers.get("Authorization"))).toEqual([
    "Bearer token-g1-1",
    "Bearer token-g1-2",
    "Bearer token-g1-3",
  ]);
});
