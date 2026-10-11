/** A fake Drive for the tools' tests: a FakeProvider answering the calls the extension makes. */

import { DRIVE_READONLY } from "../connection";
import type { FakeAccount, FakeProvider } from "./fake-api";

export const DOC_ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz";
export const ACCOUNT: FakeAccount = {
  id: "g1",
  provider: "google",
  account: "maryam@example.com",
  scopes: [DRIVE_READONLY],
};

export type DriveData = {
  files?: unknown[];
  nextPageToken?: string;
  markdown?: string;
  commentPages?: { comments: unknown[]; nextPageToken?: string }[];
  /** Statuses to answer with first, one per request, before the real answers. */
  failWith?: { status: number; retryAfter?: string }[];
  /** Answer everything with this status, e.g. 404. */
  always?: number;
};

/** The provider, and the URLs it was asked for. */
export function fakeDrive(data: DriveData = {}): { provider: FakeProvider; urls: URL[] } {
  const urls: URL[] = [];
  const failures = [...(data.failWith ?? [])];
  const commentPages = [...(data.commentPages ?? [{ comments: [] }])];
  const provider: FakeProvider = (request) => {
    const url = new URL(request.url);
    urls.push(url);
    const failure = failures.shift();
    const status = failure?.status ?? data.always;
    if (status !== undefined) {
      const headers: Record<string, string> =
        failure?.retryAfter === undefined ? {} : { "Retry-After": failure.retryAfter };
      return Response.json({ error: { message: "nope" } }, { status, headers });
    }
    if (url.pathname.endsWith("/export")) return new Response(data.markdown ?? "");
    if (url.pathname.endsWith("/comments")) {
      return Response.json(commentPages.shift() ?? { comments: [] });
    }
    if (url.pathname.endsWith("/files")) {
      return Response.json({ files: data.files ?? [], nextPageToken: data.nextPageToken });
    }
    return Response.json({
      name: "Plan",
      webViewLink: `https://docs.google.com/document/d/${DOC_ID}/edit`,
    });
  };
  return { provider, urls };
}
