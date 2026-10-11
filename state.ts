/**
 * The extension's own `state.json`: which session started from which Doc, the
 * changes page token and the Google connection the reader chose. No secret in
 * it. Written atomically (temp file + rename); a broken file reads as empty.
 */

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionApi } from "@prifly/extension-api";

/** A Doc a session was started from, and the Doc's last edit that session has seen. */
export type LaunchedDoc = { docId: string; title: string; modifiedTime: string | null };

export type State = {
  sessions: Record<string, LaunchedDoc>;
  pageToken: string | null;
  connection: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function emptyState(): State {
  return { sessions: {}, pageToken: null, connection: null };
}

function parseState(raw: unknown): State {
  const state = emptyState();
  if (!isRecord(raw)) return state;
  state.pageToken = text(raw["pageToken"]);
  state.connection = text(raw["connection"]);
  const sessions = raw["sessions"];
  if (!isRecord(sessions)) return state;
  for (const [id, each] of Object.entries(sessions)) {
    if (!isRecord(each)) continue;
    const docId = text(each["docId"]);
    if (docId === null) continue;
    state.sessions[id] = {
      docId,
      title: text(each["title"]) ?? "(untitled)",
      modifiedTime: text(each["modifiedTime"]),
    };
  }
  return state;
}

/** The state in memory, and the file it is kept in. */
export class StateStore {
  state: State;
  private readonly file: string;
  private readonly log: ExtensionApi["log"];

  constructor(api: ExtensionApi) {
    this.file = join(api.folder, "state.json");
    this.log = api.log;
    this.state = this.read();
  }

  private read(): State {
    let content: string;
    try {
      content = readFileSync(this.file, "utf8");
    } catch {
      return emptyState();
    }
    try {
      return parseState(JSON.parse(content));
    } catch (error) {
      this.log("state-unreadable", { message: error instanceof Error ? error.message : "?" });
      return emptyState();
    }
  }

  /** Writes the state to disk; a failed write is logged, never thrown. */
  save(): void {
    const temp = `${this.file}.${process.pid}.tmp`;
    try {
      writeFileSync(temp, `${JSON.stringify(this.state, null, 2)}\n`);
      renameSync(temp, this.file);
    } catch (error) {
      this.log("state-not-saved", { message: error instanceof Error ? error.message : "?" });
    }
  }

  /** The session ids that were started from `docId`. */
  sessionsOf(docId: string): string[] {
    return Object.entries(this.state.sessions)
      .filter(([, each]) => each.docId === docId)
      .map(([id]) => id);
  }
}
