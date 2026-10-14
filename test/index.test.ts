import { afterEach, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionManifest, ExtensionModule } from "@prifly/extension-api";
import * as extension from "../index";
import manifest from "../prifly-extension.json";
import { STATUS_EVERY_MS } from "../status";
import { fakeApi, fakeConnections } from "./fake-api";
import { ACCOUNT, fakeDrive } from "./fake-drive";
import { FakeTimers, settle } from "./helpers";

// The module is what prifly imports: it must fit the contract as a whole.
const module: ExtensionModule = extension;
const ROOT = join(import.meta.dir, "..");

let stop: (() => void) | undefined;
afterEach(() => {
  stop?.();
  stop = undefined;
});

test("the manifest asks Google for Docs and Drive, and has no launcher", () => {
  const read: ExtensionManifest = manifest as ExtensionManifest;
  expect(read.id).toBe("google-docs");
  expect(read.connections).toEqual([
    expect.objectContaining({
      provider: "google",
      scopes: [
        "https://www.googleapis.com/auth/documents",
        "https://www.googleapis.com/auth/drive",
      ],
    }),
  ]);
  expect("launch" in manifest).toBe(false);
  expect("panels" in manifest).toBe(false);
});

test("the module exports no launcher or chip handlers", () => {
  expect(Object.keys(extension).sort()).toEqual(["activate", "start"]);
});

test("no source calls api.show or api.flag", () => {
  const sources = readdirSync(ROOT).filter((name) => name.endsWith(".ts"));
  expect(sources).toContain("index.ts");
  for (const name of sources) {
    const source = readFileSync(join(ROOT, name), "utf8");
    expect(source).not.toMatch(/\.(show|flag)\s*\(/);
  }
});

test("activate registers the tools, sets the status line, and shows or flags nothing", async () => {
  const drive = fakeDrive({ countPages: [[{ id: "a" }, { id: "b" }], [{ id: "c" }]] });
  const connected = fakeConnections({ accounts: [{ ...ACCOUNT }], provider: drive.provider });
  const fake = fakeApi({ connections: connected.connections });
  const timers = new FakeTimers();
  stop = extension.start(fake.api, { timers });
  await settle();
  expect(fake.tools()).toHaveLength(11);
  expect(fake.statuses).toEqual(["Connected · 3 Docs in Drive"]);
  expect(fake.logs).toEqual([{ event: "activated", fields: {} }]);
  expect(fake.shown).toEqual([]);
  expect(fake.flags.size).toBe(0);
  expect(timers.pending()).toEqual([STATUS_EVERY_MS]);
  stop();
  stop = undefined;
  expect(timers.pending()).toEqual([]);
});

test("activate works with the real clock and stops cleanly", async () => {
  const fake = fakeApi();
  stop = (await module.activate(fake.api)) ?? undefined;
  await settle();
  expect(fake.statuses).toEqual([
    "This version of prifly gives extensions no access to Google accounts: update prifly.",
  ]);
});
