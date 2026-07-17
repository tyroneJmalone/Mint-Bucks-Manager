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
- **A job enters Printavo as a `Quote`, then becomes an `Invoice` when approved.** The shop's
  real workflow creates quotes first, so notifications MUST fire at quote stage — polling
  `invoices` only would miss brand-new orders and send no email at all.
- **Poll the `orders` union field (OrderUnion = Quote | Invoice)**, NOT `invoices`. This
  surfaces an order at creation (quote) time and also covers orders created directly as
  invoices.
  - **Union query syntax:** you CANNOT select fields directly on `orders` — use inline
    fragments `... on Quote { ... } ... on Invoice { ... }` with identical field sets.
    `totalNodes` does NOT exist on `OrderUnionConnection` (it exists on typed connections),
    but `first`/`after`/`sortOn`/`sortDescending`/`pageInfo`/`query` all work on the union.
- **`OrderSortField` has NO created-at option** (only `VISUAL_ID`, `TOTAL`, etc.). To get
  "recent" orders we sort `VISUAL_ID` descending and filter `timestamps.createdAt >= since`
  client-side, stopping once we page past `since`.
  - **Why this is valid:** live probe confirmed `visualId` is monotonic with `createdAt`
    (higher visualId ⇒ later creation), so VISUAL_ID DESC is a sound recency proxy.
- **Notification dedup keys on (customer_id, printavo_order_id) = Printavo internal `id`**
  (unique index + ON CONFLICT DO NOTHING). **UNVERIFIED:** whether a quote→invoice conversion
  reuses the same `id`/`visualId`/`createdAt` or mints a new record. A probe hint (a quote and
  an invoice for the same contact had adjacent but DIFFERENT visualIds) suggests it may mint a
  new record — in which case a customer could get a second reminder email when their quote is
  approved. Bounded (duplicate reminder, not data corruption). To confirm: approve a quote and
  re-poll; if it dupes, add a per-customer suppression window.
- **Lookup by order number:** `orders(query: "<number>")` does a fuzzy search (also matches
  nickname/PO), so filter results to an exact `visualId` match — never trust `nodes[0]`.
- **Auth headers:** `email` + `token` (not Authorization). Rate limit ~10 req / 5s per
  email/IP; serialize requests through a single throttle (≥620ms spacing — see "Rate limit
  margin" below) to avoid 429s.

## Quotes never appear in `invoices` — pipeline/forecast must scan the orders union
The rewards pipeline originally queried only `invoices(paymentStatus: UNPAID|PARTIAL_PAYMENT)`
and showed 0 items while a $1,500 quote sat open. **Why:** `invoices` returns only approved
Invoices; open Quotes are invisible to it. **How to apply:** any "upcoming/open work" feature
must also page the `orders` union and keep `__typename === "Quote"` nodes (Quote supports the
full invoice field set: total, amountPaid, tags, status, dueAt, customerDueAt, contact —
verified live). Invoice nodes from the union are skipped to avoid double-counting with the
paymentStatus queries.

## Rate limit margin
550ms request spacing (≈9.1 req/5s) tripped real 429s during startup bursts (poller scan +
on-demand pipeline). Use ≥620ms (≈8 req/5s) and retry once after ~5s on 429 — a lone 429
should not fail a whole scan.

## Invoices query (payment polling — Rewards)
The `invoices` query supports server-side filters: `paymentStatus` (enum
`UNPAID` | `PARTIAL_PAYMENT` | `PAID`), `tags`, `statusIds`, `inProductionAfter` /
`inProductionBefore`. Confirmed-live invoice fields: `total`, `amountPaid`, `tags`,
`status { id name }`, `timestamps { createdAt }`, `dueAt`, `customerDueAt`,
`contact { ... email }`.
- **No `paidAt` field and no created/updated sort** (same `OrderSortField` limitation).
  You cannot page invoices in payment-time order. To find newly-PAID invoices, filter
  `paymentStatus: PAID`, sort `VISUAL_ID` desc (≈ creation order), and stop paging past a
  creation-time cutoff.
- **Why lookback + dedup:** an invoice can be paid long after it was created, so a pure
  creation-time window misses late payments. Mitigate with a generous lookback window and an
  idempotent dedup ledger so overlapping re-scans are harmless. "Paid on/after <date>" is only
  approximable via `createdAt` — there is no true paid-at timestamp.
- **Payment dates ARE derivable per order:** Quote/Invoice expose a `transactions` connection
  (TransactionUnion = Payment | Refund | Return | Void | PaymentDispute). `Payment` nodes carry
  `transactionDate` (plain YYYY-MM-DD — beware `new Date("YYYY-MM-DD")` UTC day-shift when
  rendering). "Date paid" = max Payment transactionDate; ignore non-Payment members. Nesting
  `transactions(first: 25)` inside 25-node pages passed live with no complexity errors.
  - **`transactionDate` can differ by ±1 day between endpoints** for the same Payment
    (observed live: `orders(query:)` said 2026-07-15, `invoice(id:)` said 2026-07-16 for the
    identical transaction) — a Printavo-side timezone rendering quirk. Treat stored paid dates
    as approximate to ±1 day; don't chase such off-by-one "bugs" in our code.
- Page size still capped at 25 regardless of `first`.

## Environment quirk for probing
The `code_execution` (JS notebook) sandbox does **not** have `PRINTAVO_EMAIL` /
`PRINTAVO_API_KEY` in its env, but the **bash shell does**. Run live API probe scripts
from bash (`node /tmp/probe.mjs`), not from code_execution.
