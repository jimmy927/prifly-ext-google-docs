# prifly-ext-google-docs

Your Google Docs in prifly:

- **From a Google Doc…** — a launcher with your Starred, Recent and Shared
  Docs and a search over your Drive. The session starts knowing the whole Doc
  as Markdown, with its open comments and pictures.
- **Tools for every session** — `google_docs_search`, `google_docs_read`
  (a Doc as Markdown, by id or link) and `google_docs_comments`.
- **Change chip** — a session started from a Doc gets a chip on its banner
  when the Doc is edited, offering "Send the changes" (or "Dismiss"). Nothing
  reaches the session until you choose it. Drive is polled every
  `refreshSeconds` (default 120); `state.json` in the extension's folder keeps
  which session came from which Doc and the changes page token.

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

## License and contributing

Source-available under the Functional Source License 1.1 with an Apache 2.0 future license (`LICENSE.md`): use it, change it and fix it freely, but not to offer a competing product. Each version becomes Apache 2.0 two years after its release.

Pull requests are welcome. Before one can be merged, its author signs the contributor agreement (`CLA.md`), which assigns the copyright in the contribution to The Startup Factory AB; the CLA bot asks for it on the pull request.
