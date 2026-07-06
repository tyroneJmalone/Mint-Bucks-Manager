---
name: pnpm monorepo build + dependency gotchas
description: Project-reference declaration rebuilds and zod availability across workspace packages
---

# Monorepo build & dependency gotchas

## `@workspace/db` is consumed via built declarations, not src
- `lib/db` is a TypeScript **project reference** (composite, `emitDeclarationOnly`,
  output in `lib/db/dist/*.d.ts`). Consumers like `@workspace/api-server` read
  those `.d.ts` files, NOT `lib/db/src`.
- After editing db schema (new tables/columns/exports), a plain
  `tsc -p ... --noEmit` in a consumer still sees the **stale** declarations and
  reports "no exported member" / "property does not exist".
- Fix: regenerate declarations first with `pnpm run typecheck:libs`
  (= `tsc --build` at repo root), then re-run the consumer typecheck.
  **How to apply:** any schema change in `lib/db` → run `typecheck:libs` before
  trusting a consumer's typecheck or before codegen.

## zod availability per package
- The workspace catalog pins `zod: ^3.25.76`, which DOES expose the `zod/v4`
  subpath (schema code imports `from "zod/v4"`).
- `@workspace/api-server` does not depend on zod by default (it only re-exports
  via `@workspace/api-zod`). To use zod directly in api-server, add
  `"zod": "catalog:"` to its dependencies and `pnpm install`, then import from
  `"zod/v4"` to match the rest of the codebase.
