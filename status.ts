/**
 * The extension's one line in Settings → Extensions: "Connected · 41 Docs in
 * Drive", or what is in the way of the Google account. Asked at activation
 * and then at most every 15 minutes.
 */

import type { ExtensionApi } from "@prifly/extension-api";
import { failure, googleFor } from "./common";
import { signInText } from "./connection";
import { countDocs, SignInError } from "./drive";
import { realTimers, type TimerHandle, type Timers } from "./timers";

export const STATUS_EVERY_MS = 15 * 60_000;

/** "Connected · 41 Docs in Drive"; "10000+" when there were more than were counted. */
export function connectedText(count: number, more: boolean): string {
  const shown = more ? `${count}+` : String(count);
  return `Connected · ${shown} ${count === 1 && !more ? "Doc" : "Docs"} in Drive`;
}

export class StatusLine {
  private timer: TimerHandle | null = null;
  private stopped = false;
  private readonly abort = new AbortController();
  private readonly api: ExtensionApi;
  private readonly timers: Timers;

  constructor(api: ExtensionApi, timers?: Timers) {
    this.api = api;
    this.timers = timers ?? realTimers();
  }

  /** The first line now, then one every 15 minutes. */
  start(): void {
    void this.refresh();
  }

  /** Asks Google once and sets the line; the next refresh is 15 minutes after this one. */
  async refresh(): Promise<void> {
    const status = this.api.status;
    if (this.stopped || status === undefined) return;
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = this.timers.set(() => void this.refresh(), STATUS_EVERY_MS);
    const line = await this.line();
    if (!this.stopped) status(line);
  }

  private async line(): Promise<string> {
    const found = googleFor(this.api);
    if ("problem" in found) return found.problem;
    try {
      const { count, more } = await countDocs(found.google, this.abort.signal);
      return connectedText(count, more);
    } catch (error) {
      if (this.stopped) return "";
      if (error instanceof SignInError) return signInText(error.account);
      const sentence = failure(error, null) ?? (error instanceof Error ? error.message : "?");
      this.api.log("status-failed", { message: sentence });
      return `Connected · could not count the Docs in Drive: ${sentence}`;
    }
  }

  stop(): void {
    this.stopped = true;
    this.abort.abort();
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
  }
}
