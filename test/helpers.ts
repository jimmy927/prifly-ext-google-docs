/** What the board, launch and watcher tests share: a runtime over a fake account and a fake Drive. */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime, type Runtime } from "../runtime";
import type { TimerHandle, Timers } from "../timers";
import { Watcher } from "../watch";
import { type FakeAccount, type FakeApi, fakeApi, fakeConnections } from "./fake-api";
import { ACCOUNT, type DriveData, fakeDrive } from "./fake-drive";

/** A clock the test drives: timers run when `fire` says so. */
export class FakeTimers implements Timers {
  private nextId = 0;
  private readonly waiting = new Map<number, { run: () => void; ms: number }>();

  set(run: () => void, ms: number): TimerHandle {
    const id = ++this.nextId;
    this.waiting.set(id, { run, ms });
    return { id };
  }

  clear(handle: TimerHandle): void {
    this.waiting.delete(handle.id);
  }

  /** The waits of the timers still pending. */
  pending(): number[] {
    return [...this.waiting.values()].map((each) => each.ms);
  }

  /** Runs every pending timer once. */
  fire(): void {
    const all = [...this.waiting.entries()];
    for (const [id, timer] of all) {
      this.waiting.delete(id);
      timer.run();
    }
  }
}

/** Lets the promises a tick or a fill started finish. */
export async function settle(): Promise<void> {
  await Bun.sleep(15);
}

export type SetupOptions = {
  accounts?: FakeAccount[];
  settings?: Record<string, number>;
  /** The ids of the sessions that exist. */
  sessions?: string[];
  folder?: string;
  firstFillWaitMs?: number;
};

export type Setup = ReturnType<typeof setup>;

export function setup(data: DriveData = {}, options: SetupOptions = {}) {
  const drive = fakeDrive(data);
  const accounts = options.accounts ?? [{ ...ACCOUNT }];
  const connected = fakeConnections({ accounts, provider: drive.provider });
  const folder = options.folder ?? mkdtempSync(join(tmpdir(), "gdocs-"));
  const fake: FakeApi = fakeApi({
    connections: connected.connections,
    settings: options.settings ?? { refreshSeconds: 120 },
    folder,
  });
  const alive = new Set(options.sessions ?? []);
  fake.api.session = (id) => (alive.has(id) ? { id, title: id, cwd: "/", state: "idle" } : null);
  const prompts: { session: string; text: string }[] = [];
  fake.api.prompt = async (session, text) => {
    prompts.push({ session, text });
    return { delivered: true };
  };
  const signIns: unknown[][] = [];
  const signIn = connected.connections.signIn;
  connected.connections.signIn = (...args) => {
    signIns.push(args);
    return signIn(...args);
  };
  let onSettings: ((values: Record<string, number>) => void) | undefined;
  fake.api.onSettings = (handler) => {
    onSettings = handler;
  };
  const timers = new FakeTimers();
  const runtime: Runtime = createRuntime(fake.api, {
    timers,
    debounceMs: 400,
    firstFillWaitMs: options.firstFillWaitMs ?? 1500,
  });
  const watcher = new Watcher(runtime);
  return {
    ...connected,
    fake,
    folder,
    runtime,
    watcher,
    timers,
    prompts,
    signIns,
    alive,
    urls: drive.urls,
    concurrency: drive.concurrency,
    changeSettings(values: Record<string, number>) {
      fake.api.settings = values;
      onSettings?.(values);
    },
  };
}

/** A Drive file as `files.list` answers it. */
export function file(id: string, name: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name,
    modifiedTime: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    lastModifyingUser: { displayName: "Maryam" },
    owners: [{ displayName: "Maryam" }],
    webViewLink: `https://docs.google.com/document/d/${id}/edit`,
    ...extra,
  };
}

/** A Doc id of the right shape. */
export function docId(n: number): string {
  return `doc${String(n).padStart(2, "0")}-AbCdEfGhIjKlMnOp`;
}
