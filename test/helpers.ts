/** What the tool tests share: the tools over a fake account and a fake Google, and a clock to drive. */

import type { TimerHandle, Timers } from "../timers";
import { registerTools } from "../tools";
import { type FakeAccount, fakeApi, fakeConnections } from "./fake-api";
import { ACCOUNT, type DriveData, fakeDrive } from "./fake-drive";

/** Tools over a fake account; `signIns` counts calls to signIn, `writes` the requests that are not a GET. */
export function setup(
  data: DriveData = {},
  accounts: FakeAccount[] = [{ ...ACCOUNT }],
  options: { confirm?: boolean } = {},
) {
  const drive = fakeDrive(data);
  const fake = fakeConnections({ accounts, provider: drive.provider });
  const signIns: unknown[][] = [];
  const signIn = fake.connections.signIn;
  fake.connections.signIn = (...args) => {
    signIns.push(args);
    return signIn(...args);
  };
  const api = fakeApi({ connections: fake.connections, ...options });
  registerTools(api.api);
  const writes = () => drive.sent.filter((each) => each.method !== "GET");
  return { ...fake, ...api, urls: drive.urls, sent: drive.sent, writes, signIns };
}

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

/** Lets the promises a refresh started finish. */
export async function settle(): Promise<void> {
  await Bun.sleep(15);
}
