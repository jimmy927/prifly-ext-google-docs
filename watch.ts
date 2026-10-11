/**
 * Polls Drive's changes feed while the extension is active. A change to a Doc
 * on the board refreshes the board's cache; a change to a Doc a session was
 * started from puts a chip on that session that only OFFERS to send the
 * changes: nothing reaches the session until the reader chooses it.
 */

import type { Decoration } from "@prifly/extension-api";
import { errorText } from "./board";
import {
  DOC_MIME_TYPE,
  type DocChange,
  type Drive,
  DriveHttpError,
  DriveSignInError,
  docInfo,
  exportMarkdown,
  listChanges,
  startPageToken,
} from "./drive";
import { promptBody } from "./launch";
import { extractPictures } from "./markdown";
import { access, type Runtime, refreshMs } from "./runtime";
import type { TimerHandle } from "./timers";
import { relativeTime } from "./tools";

export const SEND_CHANGES = "send-changes";
export const DISMISS = "dismiss";

type Chip = { docId: string; editor: string | null; modifiedTime: string | null };

const CALL_TIMEOUT_MS = 60_000;

function later(time: string | null, than: string | null): boolean {
  const a = time === null ? Number.NaN : Date.parse(time);
  if (Number.isNaN(a)) return false;
  const b = than === null ? Number.NaN : Date.parse(than);
  return Number.isNaN(b) || a > b;
}

export class Watcher {
  private readonly runtime: Runtime;
  private readonly chips = new Map<string, Chip>();
  private timer: TimerHandle | null = null;
  private stopped = false;
  private paused = false;
  private shown = false;

  constructor(runtime: Runtime) {
    this.runtime = runtime;
  }

  /** Polls now, then every `refreshSeconds`; a new setting applies to the next wait. */
  start(): void {
    this.stopped = false;
    this.runtime.api.onSettings?.(() => {
      if (this.timer !== null) this.schedule(refreshMs(this.runtime.api));
    });
    this.schedule(0);
  }

  /** Clears the timer; a poll in flight finishes without scheduling another. */
  stop(): void {
    this.stopped = true;
    if (this.timer !== null) this.runtime.timers.clear(this.timer);
    this.timer = null;
  }

  /** The sessions that have a chip now. */
  chipSessions(): string[] {
    return [...this.chips.keys()];
  }

  /** One poll. */
  async tick(): Promise<void> {
    if (this.stopped) return;
    this.prune();
    try {
      await this.poll();
    } catch (error) {
      this.failed(error);
    }
    if (!this.stopped) this.render();
  }

  /** The chip's menu on the session `key`: "send-changes" or "dismiss". */
  async act(key: string, actionId: string): Promise<string | undefined> {
    const chip = this.chips.get(key);
    const seen = this.runtime.store.state.sessions[key];
    if (chip === undefined || seen === undefined) return "That edit is no longer pending.";
    if (actionId === DISMISS) {
      seen.modifiedTime = chip.modifiedTime ?? seen.modifiedTime;
      this.clear(key);
      return "Dismissed.";
    }
    if (actionId !== SEND_CHANGES) return undefined;
    try {
      return await this.sendChanges(key, chip);
    } catch (error) {
      return `Could not read the Doc: ${errorText(error)}`;
    }
  }

  private schedule(ms: number): void {
    if (this.timer !== null) this.runtime.timers.clear(this.timer);
    this.timer = this.runtime.timers.set(() => {
      this.timer = null;
      void this.tick().finally(() => {
        if (!this.stopped && this.timer === null) this.schedule(refreshMs(this.runtime.api));
      });
    }, ms);
  }

  private pause(account: string): void {
    if (this.paused) return;
    this.paused = true;
    this.runtime.api.log("watch-paused", { account });
  }

  private failed(error: unknown): void {
    const { api, store } = this.runtime;
    if (error instanceof DriveSignInError) {
      this.pause(error.account);
      return;
    }
    if (error instanceof DriveHttpError && error.status >= 400 && error.status < 500) {
      // The page token went stale: start again from now.
      store.state.pageToken = null;
      store.save();
      api.log("watch-token-reset", { status: error.status });
      return;
    }
    api.log("watch-failed", { message: errorText(error) });
  }

  private async poll(): Promise<void> {
    const { api, store } = this.runtime;
    const { state, drive } = access(this.runtime);
    if (state.kind === "needs-sign-in") {
      this.pause(state.connection.account);
      return;
    }
    if (drive === null) return;
    if (this.paused) {
      this.paused = false;
      api.log("watch-resumed");
    }
    const signal = AbortSignal.timeout(CALL_TIMEOUT_MS);
    const token = store.state.pageToken;
    if (token === null) {
      store.state.pageToken = await startPageToken(drive, signal);
      store.save();
      return;
    }
    const { changes, next } = await listChanges(drive, token, signal);
    this.handle(changes, drive);
    store.state.pageToken = next;
    store.save();
  }

  private handle(changes: DocChange[], drive: Drive): void {
    const { cache } = this.runtime;
    if (changes.some((each) => cache.find(each.fileId) !== undefined)) {
      cache.invalidate();
      void cache.ensure(drive);
    }
    for (const change of changes) {
      if (!change.removed && change.mimeType === DOC_MIME_TYPE) this.note(change);
    }
  }

  /** A chip on each session started from the Doc, when this edit is newer than what it saw. */
  private note(change: DocChange): void {
    const { store } = this.runtime;
    for (const session of store.sessionsOf(change.fileId)) {
      const seen = store.state.sessions[session];
      if (seen === undefined || !later(change.modifiedTime, seen.modifiedTime)) continue;
      const have = this.chips.get(session);
      if (have !== undefined && !later(change.modifiedTime, have.modifiedTime)) continue;
      this.chips.set(session, {
        docId: change.fileId,
        editor: change.editor,
        modifiedTime: change.modifiedTime,
      });
    }
  }

  /** Forgets sessions prifly no longer has. */
  private prune(): void {
    const { api, store } = this.runtime;
    if (!api.features?.includes("session-lookup")) return;
    let dropped = false;
    for (const id of Object.keys(store.state.sessions)) {
      if (api.session(id) !== null) continue;
      delete store.state.sessions[id];
      this.chips.delete(id);
      dropped = true;
    }
    if (dropped) store.save();
  }

  private clear(session: string): void {
    this.chips.delete(session);
    this.runtime.store.save();
    this.render();
  }

  private render(): void {
    if (this.chips.size === 0 && !this.shown) return;
    const bySession: Record<string, Decoration[]> = {};
    for (const [session, chip] of this.chips) bySession[session] = [this.decoration(session, chip)];
    this.runtime.api.show(bySession, []);
    this.shown = this.chips.size > 0;
  }

  private decoration(session: string, chip: Chip): Decoration {
    const title = this.runtime.store.state.sessions[session]?.title ?? "A Doc";
    const when = relativeTime(chip.modifiedTime, this.runtime.now());
    return {
      key: session,
      icon: "link",
      label: `Doc edited by ${chip.editor ?? "someone"} · ${when}`,
      tone: "info",
      details: [title],
      url: `https://docs.google.com/document/d/${chip.docId}/edit`,
      actions: [
        { id: SEND_CHANGES, label: "Send the changes" },
        { id: DISMISS, label: "Dismiss" },
      ],
    };
  }

  private async sendChanges(session: string, chip: Chip): Promise<string> {
    const { api } = this.runtime;
    const { drive } = access(this.runtime);
    const seen = this.runtime.store.state.sessions[session];
    if (drive === null || seen === undefined)
      return "That Google account cannot be read right now.";
    const signal = AbortSignal.timeout(CALL_TIMEOUT_MS);
    const info = await docInfo(drive, chip.docId, signal);
    const text = extractPictures(await exportMarkdown(drive, chip.docId, signal)).text;
    const editor = info.modifiedBy ?? chip.editor ?? "someone";
    const message = `The Google Doc "${info.name}" was edited by ${editor} at ${info.modifiedTime ?? "an unknown time"}. Its text now:\n\n${promptBody(text, chip.docId)}`;
    const sent = await api.prompt(session, message);
    if (!sent.delivered) return "The session could not be reached: the chip stays.";
    seen.modifiedTime = info.modifiedTime ?? chip.modifiedTime;
    this.clear(session);
    return "Sent the changes to the session.";
  }
}
