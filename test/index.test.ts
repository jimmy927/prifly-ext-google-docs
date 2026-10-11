import { afterEach, expect, test } from "bun:test";
import type { ExtensionManifest, ExtensionModule } from "@prifly/extension-api";
import * as extension from "../index";
import manifest from "../prifly-extension.json";
import { fakeApi } from "./fake-api";

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

test("activate logs and stops cleanly", async () => {
  const fake = fakeApi();
  stop = (await module.activate(fake.api)) ?? undefined;
  expect(fake.logs).toEqual([{ event: "activated", fields: {} }]);
  expect(extension.current()).toBe(fake.api);
  stop?.();
  stop = undefined;
  expect(extension.current()).toBeNull();
});
