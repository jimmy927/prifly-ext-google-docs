# prifly-ext-google-docs

Your Google Docs in every prifly session. You ask in plain words; the session
finds, reads, creates and edits Docs in place and answers their comments. It
has no launcher, chip or panel of its own.

Tools:

- `google_docs_search`, `google_docs_read` (a Doc as Markdown, by id or link)
  and `google_docs_comments` (the open comments, with their ids).
- `google_docs_read_structure`: paragraphs with their start and end indexes,
  style and list, and the Doc's `revisionId`.
- `google_docs_create`: a new Doc from Markdown (Drive converts the upload).
- `google_docs_edit`: replace text, insert after a heading or at an index,
  delete a range, set a heading, bold or a bullet list. All of one call goes
  out as one `documents.batchUpdate` with `writeControl.requiredRevisionId`,
  so the same Doc changes in place and Google's version history keeps each
  step. The requests are ordered so none moves the text a later one points at.
  Structure and edits cover the Doc's first tab; `replace_text` is held to
  that tab and also reaches its headers, footers and footnotes, which the
  confirm card counts.
  If the Doc changed since the read, nothing is written: the session reads it
  again and rebuilds the edit. It never makes a copy.
- `google_docs_comment_reply` and `google_docs_comment_resolve`.
- `google_docs_api`: any Docs v1, Drive v3 or Sheets v4 call (add a tab, write cells) with your account (other
  hosts are refused), and `google_docs_api_docs`, which looks the method up in
  Google's discovery documents.
- `google_docs_sign_in`: asks you in the browser for Docs and Drive access.

Reads run at once. Every write (create, edit, reply, resolve, and any
`google_docs_api` call that is not a GET) is shown to you on a confirm card
with the exact change first; Cancel sends nothing.

Settings → Extensions shows one line: "Connected · 41 Docs in Drive", or what
is in the way of the Google account. It is refreshed at most every 15 minutes.

## Account

It uses a Google account connected in prifly's Vault → Connections, through
`api.connections`: prifly holds the token and adds it to each request. It asks
Google for `documents` and `drive`. An account connected for the earlier,
read-only version approves once more: ask any session to sign in to Google
Docs, or connect the account again in Vault → Connections. `drive` is a
restricted scope: it works on your own Google client (Vault → Connections →
your client JSON) without Google's verification.

## Develop

```sh
bun install
bun test && bunx tsc --noEmit && bunx biome check .
```

Types come from `@prifly/extension-api`, pinned to a tag of
`jimmy927/prifly-extension-api` (v0.6.0, which has `api.confirm` and
`api.status`). Tests run against `test/fake-api.ts`, a fake of prifly's `api`
with a fake token endpoint, and `test/fake-drive.ts`, a fake of the Drive and
Docs APIs; they never call Google.

## License and contributing

Source-available under the Functional Source License 1.1 with an Apache 2.0 future license (`LICENSE.md`): use it, change it and fix it freely, but not to offer a competing product. Each version becomes Apache 2.0 two years after its release.

Pull requests are welcome. Before one can be merged, its author signs the contributor agreement (`CLA.md`), which assigns the copyright in the contribution to The Startup Factory AB; the CLA bot asks for it on the pull request.
