/**
 * Which Google account the extension can use right now: one place deciding
 * the state, for the tools and (later) the launcher and the watcher.
 */

import type { ExtensionApi, ExtensionConnection } from "@prifly/extension-api";

export const DRIVE_READONLY = "https://www.googleapis.com/auth/drive.readonly";

export type ConnectionState =
  | { kind: "no-api" }
  | { kind: "none" }
  | { kind: "scope-missing"; connection: ExtensionConnection }
  | { kind: "needs-sign-in"; connection: ExtensionConnection }
  | { kind: "ok"; connection: ExtensionConnection };

/** Prefers an ok connection that has the Drive scope; with several, the first. */
export function connectionState(api: ExtensionApi): ConnectionState {
  if (api.connections === undefined) return { kind: "no-api" };
  const all = api.connections.list("google");
  const first = all[0];
  if (first === undefined) return { kind: "none" };
  const withScope = all.filter((each) => each.scopes.includes(DRIVE_READONLY));
  const usable = withScope.find((each) => each.state === "ok");
  if (usable !== undefined) return { kind: "ok", connection: usable };
  const expired = withScope[0];
  if (expired !== undefined) return { kind: "needs-sign-in", connection: expired };
  return { kind: "scope-missing", connection: first };
}

/** The sentence a tool answers with when the state is not ok. */
export function stateText(state: ConnectionState): string {
  switch (state.kind) {
    case "no-api":
      return "This version of prifly gives extensions no access to Google accounts: update prifly.";
    case "none":
      return "No Google account is connected: connect one in prifly's Vault → Connections.";
    case "scope-missing":
      return `${state.connection.account} has not given prifly read access to Drive yet. Open "From a Google Doc…" in prifly, or connect it again with Drive access in Vault → Connections.`;
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
 * Asks the reader, in their browser, for Drive read access (more scopes on
 * `connection`, or a new account). For the launcher: a tool never calls it,
 * as it would open a browser behind a session's back.
 */
export async function askForDrive(api: ExtensionApi, connection?: ExtensionConnection) {
  if (api.connections === undefined)
    return { ok: false as const, message: stateText({ kind: "no-api" }) };
  return await api.connections.signIn(
    "google",
    [DRIVE_READONLY],
    connection === undefined ? undefined : { connection: connection.id },
  );
}
