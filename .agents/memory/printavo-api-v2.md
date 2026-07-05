---
name: Printavo API v2 quirks
description: Real Printavo GraphQL API v2 schema/behavior — needed when touching the Printavo integration in api-server.
---

# Printavo API v2 (real schema, verified via live introspection)

The integration was originally coded against an **imagined** schema (`records`/`metadata`
fields, `page: Int` args, polling `quotes`). None of that exists. The real API:

- **Cursor connections**, not offset pages. Every list field returns
  `{ nodes[], pageInfo { hasNextPage endCursor } }` and takes `first` / `after`.
  There is no `page:` argument.
- **Page size is hard-capped at 25.** Passing `first: 100` still returns 25. Always
  paginate with the cursor.
- **`contacts`** hold person-level `email` / `fullName` / `phone`. **`customers` are
  company-level and have no email** — use `contacts` for customer sync.
- **`invoices` are real placed orders**; `quotes` are unapproved estimates. Notifications
  key off `invoices`. An invoice's `contact` is non-null; `timestamps { createdAt updatedAt }`
  are full datetimes.
- **`OrderSortField` has NO created-at option** (only `VISUAL_ID`, `TOTAL`, etc.). To get
  "recent" invoices we sort `VISUAL_ID` descending and filter `timestamps.createdAt >= since`
  client-side, stopping once we page past `since`.
  - **Why this is valid:** live probe confirmed `visualId` is monotonic with `createdAt`
    (higher visualId ⇒ later creation), so VISUAL_ID DESC is a sound recency proxy.
  - **Known edge case (untested):** if Printavo keeps `createdAt` from the quote when a
    quote converts to an invoice, an old quote approved today would have an old
    visualId + old createdAt and be missed. Not observed in probes; revisit detection
    (status/`updatedAt`) if customers report missed notifications.
- **Lookup by order number:** `invoices(query: "22374")` does a fuzzy search (also matches
  nickname/PO), so filter results to an exact `visualId` match — never trust `nodes[0]`.
- **Auth headers:** `email` + `token` (not Authorization). Rate limit ~10 req / 5s per
  email/IP; serialize requests through a single throttle (~550ms spacing) to avoid 429s.

## Environment quirk for probing
The `code_execution` (JS notebook) sandbox does **not** have `PRINTAVO_EMAIL` /
`PRINTAVO_API_KEY` in its env, but the **bash shell does**. Run live API probe scripts
from bash (`node /tmp/probe.mjs`), not from code_execution.
