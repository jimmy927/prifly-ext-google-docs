import { expect, test } from "bun:test";
import { connectedText, STATUS_EVERY_MS, StatusLine } from "../status";
import { type FakeAccount, fakeApi, fakeConnections } from "./fake-api";
import { ACCOUNT, type DriveData, fakeDrive } from "./fake-drive";
import { FakeTimers, settle } from "./helpers";

function statusOver(data: DriveData, accounts: FakeAccount[] = [{ ...ACCOUNT }]) {
  const drive = fakeDrive(data);
  const connected = fakeConnections({ accounts, provider: drive.provider });
  const fake = fakeApi({ connections: connected.connections });
  const timers = new FakeTimers();
  const line = new StatusLine(fake.api, timers);
  return { ...fake, ...connected, line, timers, sent: drive.sent };
}

test("the line counts the Docs in Drive, at activation and then every 15 minutes", async () => {
  const fake = statusOver({ countPages: [[{ id: "a" }], [{ id: "b" }, { id: "c" }]] });
  fake.line.start();
  await settle();
  expect(fake.statuses).toEqual(["Connected · 3 Docs in Drive"]);
  expect(fake.sent).toHaveLength(2);
  expect(fake.timers.pending()).toEqual([STATUS_EVERY_MS]);
  fake.timers.fire();
  await settle();
  expect(fake.statuses).toHaveLength(2);
  expect(fake.timers.pending()).toEqual([STATUS_EVERY_MS]);
  fake.line.stop();
  expect(fake.timers.pending()).toEqual([]);
});

test("a revoked grant shows the sign-in text; a missing scope says how to give it", async () => {
  const revoked = statusOver({});
  revoked.endpoint.revoke("g1");
  revoked.line.start();
  await settle();
  expect(revoked.statuses).toEqual([
    "Google ended the sign-in for maryam@example.com: sign in again in prifly's Vault → Connections.",
  ]);
  const scope = statusOver({}, [{ ...ACCOUNT, scopes: ["openid"] }]);
  scope.line.start();
  await settle();
  expect(scope.statuses[0]).toContain("has not given prifly access to read and edit Google Docs");
  expect(scope.sent).toEqual([]);
});

test("a failed count says so, and nothing is set after stop", async () => {
  const failing = statusOver({ always: 500 });
  failing.line.start();
  await settle();
  expect(failing.statuses).toEqual([
    "Connected · could not count the Docs in Drive: Google answered 500: nope.",
  ]);
  const stopped = statusOver({});
  stopped.line.stop();
  await stopped.line.refresh();
  expect(stopped.statuses).toEqual([]);
  expect(stopped.timers.pending()).toEqual([]);
});

test("a prifly without api.status gets no requests", async () => {
  const drive = fakeDrive({});
  const connected = fakeConnections({ accounts: [{ ...ACCOUNT }], provider: drive.provider });
  const fake = fakeApi({ connections: connected.connections, status: false });
  const timers = new FakeTimers();
  new StatusLine(fake.api, timers).start();
  await settle();
  expect(drive.sent).toEqual([]);
  expect(timers.pending()).toEqual([]);
});

test("the count reads like a sentence", () => {
  expect(connectedText(1, false)).toBe("Connected · 1 Doc in Drive");
  expect(connectedText(10_000, true)).toBe("Connected · 10000+ Docs in Drive");
});
