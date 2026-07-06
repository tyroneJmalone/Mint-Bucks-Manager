---
name: Mint Bucks system architecture
description: Key decisions, credit code format, runtime deps, and API patterns for Mint Bucks
---

# Mint Bucks Architecture

## Credit code format
`MB-{8-char uppercase hex UUID slice}` — e.g. `MB-C702E093`. Generated in api-server credits route using `crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()`.

## Runtime dependency: @swc/helpers
pdfkit → fontkit → brotli uses `@swc/helpers` at runtime. Must be installed as an explicit runtime dependency of `@workspace/api-server` even though `@swc/*` is listed in esbuild `external`. Omitting it causes "Cannot find module @swc/helpers" at startup.

**Why:** esbuild externalizes it so it's not bundled, then Node tries to resolve it at runtime from node_modules and fails if not installed.

## Email is non-blocking
Email functions in `artifacts/api-server/src/lib/email.ts` catch all errors and log them. If SMTP is not configured, emails are logged with the content but not sent. Server never crashes on email failure. Required env vars: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, FROM_EMAIL, APP_URL.

## API mutation hook shape
Generated hooks from openapi-react-query: mutation hooks take `{ data: T }` as the argument (not `T` directly). Query hooks return `T` directly.

## Binary endpoints
QR code and certificate are binary responses — frontend uses `<img src="/api/credits/:id/qr">` and `<a href="/api/credits/:id/certificate" download>` as direct URLs, not React Query hooks.

## DB status flow
credits.status: `active` → `partially_redeemed` (first partial use) → `redeemed` (balance reaches 0). Void sets `voided`. Expired credits become `expired` (manual process, not yet automated).

## Rewards engine concurrency (auto-award from paid invoices)
Each (rule, invoice) awards at most once, enforced by a DB unique constraint + conflict-ignore at claim. The annual-budget sum and the claim happen inside one advisory-lock critical section, so the limit check and the claim are atomic — no overrun, no duplicate claim, and no row is written when the limit blocks.

**Budget is reserved at CLAIM time, released on reject.** The annual sum counts processing + pending + issued, so approval must NOT re-check budget — the slot was already reserved. Edge case: an award claimed in Dec year N but approved in year N+1 consumes no year-N+1 budget — acceptable.

**Issue is atomic + claim-guarded.** Credit insert and award→issued update run in one transaction, guarded on the still-"processing" status, so a lost claim rolls back the credit (never a dangling credit). Applies to both auto-issue and manual approve.

**The stale-"processing" sweep must key off the last-updated time, not the created time.**
**Why:** last-updated is bumped at every claim (scan insert AND pending→processing flip); keying off created-time lets the sweep reclaim an old pending row mid-approval → orphaned claim → double-award.
**How to apply:** any future rewrite of the sweep/reclaim query must preserve the last-updated basis.

## Paid-date requirement is approximated
"Only award invoices paid on/after the start date" is enforced via invoice `createdAt`, because Printavo exposes no paid-at timestamp (see printavo-api-v2.md). Invoices created before the start date but paid after will never earn. Documented deviation from the "locked" requirement, accepted due to API limits.
