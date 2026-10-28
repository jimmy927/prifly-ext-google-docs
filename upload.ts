/** Drive media uploads for `google_docs_api`: reads the local file and builds the request body. */

import { readFile, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

export const UPLOAD_PREFIX = "/upload/drive/v3/";
/** The biggest file `media_path` sends in one request. */
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/** A local file a call uploads: its path, content type, bytes, and how it travels. */
export type Media = {
  path: string;
  contentType: string;
  bytes: Uint8Array;
  kind: "media" | "multipart";
};

/** The file lines of an upload for the confirm card. */
export function mediaText(media: Media): string {
  return `File: ${media.path}\nSize: ${media.bytes.length} bytes\nContent type: ${media.contentType}`;
}

/** The body of a multipart/related upload: the metadata as JSON, then the file. */
export function multipartBody(metadata: string, media: Media, boundary: string): Uint8Array {
  const head = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: ${media.contentType}\r\n\r\n`;
  const encoder = new TextEncoder();
  return Buffer.concat([encoder.encode(head), media.bytes, encoder.encode(`\r\n--${boundary}--`)]);
}

/** Why an upload URL and method are refused; null when they are fine. */
function refuseUpload(method: string, url: URL): string | null {
  const kind = url.searchParams.get("uploadType");
  if (kind === "resumable") {
    return "Refused: uploadType=resumable is not supported; use uploadType=media (content only) or multipart (metadata and content).";
  }
  if (kind !== "media" && kind !== "multipart") {
    return "Refused: a Drive upload needs uploadType=media or uploadType=multipart in the URL.";
  }
  const id = /^\/upload\/drive\/v3\/files(?:\/([^/]+))?$/.exec(url.pathname);
  if (id === null) return "Refused: uploads go to /upload/drive/v3/files or …/files/{id}.";
  const [expected, what] =
    id[1] === undefined ? ["POST", "creating a file"] : ["PATCH", "replacing a file's content"];
  return method === expected ? null : `Refused: ${what} is a ${expected}, not a ${method}.`;
}

/** The file an upload sends, or why the upload is refused. */
export async function uploadMedia(
  method: string,
  url: URL,
  mediaPath: string,
  contentType: string,
): Promise<Media | string> {
  const refused = refuseUpload(method, url);
  if (refused !== null) return refused;
  if (!isAbsolute(mediaPath)) {
    return "Refused: an upload needs media_path, the absolute path of the local file to send.";
  }
  try {
    const info = await stat(mediaPath);
    if (!info.isFile()) return `Refused: ${mediaPath} is not a file.`;
    if (info.size > MAX_UPLOAD_BYTES) {
      return `Refused: ${mediaPath} is ${info.size} bytes; uploads here stop at ${MAX_UPLOAD_BYTES}.`;
    }
    const bytes = new Uint8Array(await readFile(mediaPath));
    const type =
      contentType || Bun.file(mediaPath).type.split(";")[0] || "application/octet-stream";
    const kind = url.searchParams.get("uploadType") === "multipart" ? "multipart" : "media";
    return { path: mediaPath, contentType: type, bytes, kind };
  } catch (error) {
    return `Could not read ${mediaPath}: ${error instanceof Error ? error.message : String(error)}.`;
  }
}
