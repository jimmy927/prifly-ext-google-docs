/**
 * Which Google account the extension can use right now: one place deciding
 * the state, for the tools and the status line.
 */

import type { ExtensionApi, ExtensionConnection } from "@prifly/extension-api";

export const DOCS_SCOPE = "https://www.googleapis.com/auth/documents";
export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";
/** What the extension asks Google for: read and write Docs, find and comment on them in Drive. */
export const SCOPES = [DOCS_SCOPE, DRIVE_SCOPE];

export type ConnectionState =
  | { kind: "no-api" }
  | { kind: "none" }
  | { kind: "scope-missing"; connection: ExtensionConnection }
  | { kind: "needs-sign-in"; connection: ExtensionConnection }
  | { kind: "ok"; connection: ExtensionConnection };

function hasScopes(connection: ExtensionConnection): boolean {
  return SCOPES.every((scope) => connection.scopes.includes(scope));
}

/** Prefers an ok connection that has both scopes; with several, the first. */
export function connectionState(api: ExtensionApi): ConnectionState {
  if (api.connections === undefined) return { kind: "no-api" };
  const all = api.connections.list("google");
  const first = all[0];
  if (first === undefined) return { kind: "none" };
  const withScope = all.filter(hasScopes);
  const usable = withScope.find((each) => each.state === "ok");
  if (usable !== undefined) return { kind: "ok", connection: usable };
  const expired = withScope[0];
  if (expired !== undefined) return { kind: "needs-sign-in", connection: expired };
  return { kind: "scope-missing", connection: first };
}

/** The sentence a tool (and the status line) answers with when the state is not ok. */
export function stateText(state: ConnectionState): string {
  switch (state.kind) {
    case "no-api":
      return "This version of prifly gives extensions no access to Google accounts: update prifly.";
    case "none":
      return "No Google account is connected: ask a session to sign in to Google Docs, or connect one in prifly's Vault → Connections.";
    case "scope-missing":
      return `${state.connection.account} has not given prifly access to read and edit Google Docs yet: ask a session to sign in to Google Docs, or connect it again in prifly's Vault → Connections.`;
    case "needs-sign-in":
      return signInText(state.connection.account);
    case "ok":
      return "";
  }
}

/** Google ended the grant: the reader signs in again in prifly. */
export function signInText(account: string): string {
  return `Google ended the sign-in for ${account}: sign in again in prifly's Vault → Connections.`;
}

/**
 * Asks the reader, in their browser, for Docs and Drive access: more scopes
 * on the account they have, or a new account. Only the sign-in tool calls
 * it, when the reader asked for it.
 */
export async function askForAccess(api: ExtensionApi, connection?: ExtensionConnection) {
  if (api.connections === undefined) {
    return { ok: false as const, message: stateText({ kind: "no-api" }) };
  }
  return await api.connections.signIn(
    "google",
    SCOPES,
    connection === undefined ? undefined : { connection: connection.id },
  );
}
