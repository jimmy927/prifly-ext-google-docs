# prifly-ext-google-docs

Your Google Docs in prifly:

- **From a Google Doc…** — a launcher with your Starred, Recent and Shared
  Docs and a search over your Drive. The session starts knowing the whole Doc
  as Markdown, with its open comments and pictures.
- **Tools for every session** — `google_docs_search`, `google_docs_read`
  (a Doc as Markdown, by id or link) and `google_docs_comments`.
- **Change chip** — a session started from a Doc is told on its banner when
  the Doc is edited, with "Send the changes" to hand it the new text.

Read-only: the extension asks Google for `drive.readonly` and never writes.

## Account

It uses a Google account connected in prifly's Vault → Connections, through
`api.connections` — prifly holds the token and adds it to each request.
`drive.readonly` is a restricted scope: it works on your own Google client
(Vault → Connections → your client JSON) without Google's verification. The
first use asks for it on an account that does not have it yet.

## Develop

```sh
bun install
bun test && bunx tsc --noEmit && bunx biome check .
```

Types come from `@prifly/extension-api`, pinned to a tag of
`jimmy927/prifly-extension-api`. Tests run against `test/fake-api.ts`, a fake
of prifly's `api` with a fake token endpoint and a fake Drive.
