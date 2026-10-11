/**
 * The Google Docs extension: what prifly imports. `activate` is given the api
 * and registers what the extension offers. Types come from
 * `@prifly/extension-api` with `import type`, so nothing of it is loaded at
 * run time.
 */

import type { ExtensionApi } from "@prifly/extension-api";
import { registerTools } from "./tools";

let api: ExtensionApi | null = null;

export function activate(given: ExtensionApi): () => void {
  api = given;
  registerTools(given);
  given.log("activated", {});
  return () => {
    api = null;
  };
}

/** The api while the extension is active; null once prifly stopped it. */
export function current(): ExtensionApi | null {
  return api;
}
