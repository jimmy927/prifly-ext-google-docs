/**
 * What every tool shares: the Google handle of the connected account, the
 * sentence for a failure the reader can act on, argument readers, and the
 * confirm card every write goes through first.
 */

import type { ConfirmSpec, ExtensionApi } from "@prifly/extension-api";
import { connectionState, signInText, stateText } from "./connection";
import { type Google, GoogleHttpError, parseDocId, SignInError } from "./drive";
import { StructureError } from "./structure";

/** The `doc` argument every tool on one Doc takes. */
export const DOC_ARG = { type: "string", description: "A Doc id or a docs.google.com Doc link." };

export type Args = Record<string, unknown>;
export type Run = (google: Google, signal: AbortSignal) => Promise<string>;

export const CANCELLED = "Not done: you cancelled";
export const NO_CONFIRM =
  "Not done: this version of prifly cannot ask the reader before a write. Update prifly.";

/** The sentence for a Google failure the reader can act on; null for anything else. */
export function failure(error: unknown, doc: string | null): string | null {
  if (error instanceof SignInError) return signInText(error.account);
  if (error instanceof StructureError)
    return `${error.message}: try again, or read it as Markdown.`;
  if (!(error instanceof GoogleHttpError)) return null;
  if (error.status === 404 && doc !== null) {
    return `No Doc with id ${doc} that this account can read.`;
  }
  if (error.status === 429 || error.status === 503) {
    return `Google is busy (${error.status}): try again in a minute.`;
  }
  return `${error.message}.`;
}

/** The Google handle of the connected account, or null with the sentence for what is in the way. */
export function googleFor(api: ExtensionApi): { google: Google } | { problem: string } {
  const state = connectionState(api);
  const connections = api.connections;
  if (state.kind !== "ok" || connections === undefined) return { problem: stateText(state) };
  const id = state.connection.id;
  return { google: { fetch: (url, init) => connections.fetch(id, url, init) } };
}

/** Runs `run` against the Google account, or answers with the sentence for what is in the way. */
export async function withGoogle(
  api: ExtensionApi,
  signal: AbortSignal,
  doc: string | null,
  run: Run,
): Promise<string> {
  const found = googleFor(api);
  if ("problem" in found) return found.problem;
  try {
    return await run(found.google, signal);
  } catch (error) {
    const sentence = failure(error, doc);
    if (sentence === null) throw error;
    return sentence;
  }
}

/**
 * Asks the reader on a confirm card. Null when they confirmed; otherwise the
 * tool's answer ("Not done: you cancelled"), and no request may follow.
 */
export async function ask(api: ExtensionApi, spec: ConfirmSpec): Promise<string | null> {
  if (api.confirm === undefined) return NO_CONFIRM;
  return (await api.confirm(spec)) ? null : CANCELLED;
}

export function text(args: Args, key: string): string {
  const value = args[key];
  return typeof value === "string" ? value : "";
}

export function whole(args: Args, key: string, fallback: number): number {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;
}

export function notADoc(input: string): string {
  return `"${input}" is not a Google Doc id or a docs.google.com/document/d/<id>/… link.`;
}

/** A tool on one Doc: reads its `doc` argument (an id or a link) and runs with the account. */
export function onDoc(
  api: ExtensionApi,
  args: Args,
  signal: AbortSignal,
  run: (id: string, google: Google) => Promise<string>,
): Promise<string> {
  const input = text(args, "doc");
  const id = parseDocId(input);
  if (id === null) return Promise.resolve(notADoc(input));
  return withGoogle(api, signal, id, (google) => run(id, google));
}

/** `text` cut at `cap` characters, saying so. */
export function cut(value: string, cap: number): string {
  if (value.length <= cap) return value;
  return `${value.slice(0, cap)}\n\n[Cut here: ${value.length - cap} more characters not shown.]`;
}
