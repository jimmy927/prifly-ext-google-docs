/**
 * The Google Docs extension: what prifly imports. `activate` is given the api,
 * registers the tools and starts the watcher; `choices`, `open`, `launch`,
 * `launched` and `action` are the "From a Google Doc…" launcher. Types come
 * from `@prifly/extension-api` with `import type`, so nothing of it is loaded
 * at run time.
 */

import type {
  ActionPicked,
  ExtensionApi,
  Launch,
  LaunchBoard,
  LaunchChoice,
  LaunchItem,
} from "@prifly/extension-api";
import { choices as boardChoices } from "./board";
import { launch as launchDoc, open as openDoc, launched as recordLaunch } from "./launch";
import { createRuntime, type Runtime, type RuntimeOptions } from "./runtime";
import { registerTools } from "./tools";
import { Watcher } from "./watch";

let api: ExtensionApi | null = null;
let runtime: Runtime | null = null;
let watcher: Watcher | null = null;

const NOT_RUNNING = "The Google Docs extension is not running.";

/** `activate` with the clock and waits of the runtime replaced; for tests. */
export function start(given: ExtensionApi, options: RuntimeOptions = {}): () => void {
  api = given;
  runtime = createRuntime(given, options);
  registerTools(given);
  watcher = new Watcher(runtime);
  watcher.start();
  given.log("activated", {});
  const mine = runtime;
  return () => {
    watcher?.stop();
    mine.cache.stop();
    api = null;
    runtime = null;
    watcher = null;
  };
}

export function activate(given: ExtensionApi): () => void {
  return start(given);
}

/** The api while the extension is active; null once prifly stopped it. */
export function current(): ExtensionApi | null {
  return api;
}

export async function choices(
  _launchId: string,
  query: string,
): Promise<LaunchChoice[] | LaunchBoard> {
  if (runtime === null) return [{ key: "!stopped", title: NOT_RUNNING }];
  return await boardChoices(runtime, query);
}

export async function open(_launchId: string, key: string): Promise<LaunchItem> {
  if (runtime === null) return { title: "Google Docs", markdown: NOT_RUNNING };
  return await openDoc(runtime, key);
}

export async function launch(
  _launchId: string,
  key: string,
  input: string,
  _how: { again: boolean },
): Promise<Launch> {
  if (runtime === null) return { prompt: "", message: NOT_RUNNING };
  return await launchDoc(runtime, key, input);
}

export function launched(_launchId: string, key: string, sessionId: string): void {
  if (runtime !== null) recordLaunch(runtime, key, sessionId);
}

/** A chip's menu: "Send the changes" and "Dismiss" on a session's Doc-edited chip. */
export async function action(
  key: string,
  actionId: string,
  _picked?: ActionPicked,
): Promise<string | undefined> {
  return await watcher?.act(key, actionId);
}
