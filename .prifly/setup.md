---
setup:
  - bun install --frozen-lockfile
---

One install, from the committed `bun.lock`. It brings the dev tooling (biome,
TypeScript, `@types/bun`) and `@prifly/extension-api`, the types the
extension is written against. Nothing is built: prifly imports `index.ts`
directly.

Outside the worktree it relies on:

- `bun` on PATH.
- SSH access to GitHub as an account that can read the private
  `jimmy927/prifly-extension-api` repository: `@prifly/extension-api` comes
  from `git+ssh://git@github.com/jimmy927/prifly-extension-api.git#v0.6.0`.

The gate after it: `bun test`, `bunx tsc --noEmit`, `bunx biome check .`.
Tests run against `test/fake-api.ts` and never call Google.
