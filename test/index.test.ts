import { afterEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionManifest, ExtensionModule } from "@prifly/extension-api";
import * as extension from "../index";
import manifest from "../prifly-extension.json";
import { fakeApi, fakeConnections } from "./fake-api";
import { ACCOUNT, fakeDrive } from "./fake-drive";
import { file } from "./helpers";

// The module is what prifly imports: it must fit the contract as a whole.
const module: ExtensionModule = extension;

let stop: (() => void) | undefined;
afterEach(() => stop?.());

test("the manifest names the extension and asks Google for Drive read access only", () => {
  const read: ExtensionManifest = manifest as ExtensionManifest;
  expect(read.id).toBe("google-docs");
  expect(read.connections).toEqual([
    expect.objectContaining({
      provider: "google",
      scopes: ["https://www.googleapis.com/auth/drive.readonly"],
    }),
  ]);
});

test("activate registers the three Google Docs tools", async () => {
  const fake = fakeApi();
  stop = (await module.activate(fake.api)) ?? undefined;
  expect(fake.tools().map((tool) => tool.name)).toEqual([
    "google_docs_search",
    "google_docs_read",
    "google_docs_comments",
  ]);
});

test("activate logs and stops cleanly", async () => {
  const fake = fakeApi();
  stop = (await module.activate(fake.api)) ?? undefined;
  expect(fake.logs).toEqual([{ event: "activated", fields: {} }]);
  expect(extension.current()).toBe(fake.api);
  stop?.();
  stop = undefined;
  expect(extension.current()).toBeNull();
});

test("the launcher, the chip menu and the watcher all run through activate and stop with it", async () => {
  const drive = fakeDrive({ starred: [file("doc01-AbCdEfGhIjKlMnOp", "Alpha")] });
  const connected = fakeConnections({ accounts: [{ ...ACCOUNT }], provider: drive.provider });
  const folder = mkdtempSync(join(tmpdir(), "gdocs-"));
  const fake = fakeApi({ connections: connected.connections, folder });
  stop = (await module.activate(fake.api)) ?? undefined;
  const answer = await extension.choices("doc", "");
  expect(Array.isArray(answer)).toBe(false);
  expect(await extension.action("nobody", "send-changes")).toBe("That edit is no longer pending.");
  await Bun.sleep(30);
  expect(drive.urls.some((url) => url.pathname.endsWith("/changes/startPageToken"))).toBe(true);
  stop?.();
  stop = undefined;
  const after = await extension.choices("doc", "");
  expect(Array.isArray(after)).toBe(true);
  expect((await extension.launch("doc", "x", "", { again: false })).prompt).toBe("");
  expect((await extension.open("doc", "x")).markdown).toContain("not running");
  expect(await extension.action("nobody", "dismiss")).toBeUndefined();
});
