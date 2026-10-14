/**
 * The Google Docs extension: what prifly imports. `activate` registers the
 * tools a session uses to read, create and edit Docs in place, and keeps the
 * status line in Settings current. It has no launcher, chip or panel. Types
 * come from `@prifly/extension-api` with `import type`, so nothing of it is
 * loaded at run time.
 */

import type { ExtensionApi } from "@prifly/extension-api";
import { StatusLine } from "./status";
import type { Timers } from "./timers";
import { registerTools, type ToolOptions } from "./tools";

export type StartOptions = Pick<ToolOptions, "fetchPublic"> & { timers?: Timers };

/** `activate` with the clock and the public fetch replaced; for tests. */
export function start(api: ExtensionApi, options: StartOptions = {}): () => void {
  const status = new StatusLine(api, options.timers);
  const tools: ToolOptions = { onSignedIn: () => void status.refresh() };
  if (options.fetchPublic !== undefined) tools.fetchPublic = options.fetchPublic;
  registerTools(api, tools);
  status.start();
  api.log("activated", {});
  return () => status.stop();
}

export function activate(api: ExtensionApi): () => void {
  return start(api);
}
