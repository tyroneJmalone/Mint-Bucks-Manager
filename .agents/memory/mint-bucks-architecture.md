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

## Clearing a nullable field on PATCH/update: send null, never undefined
To CLEAR an optional/nullable field via a generated update, send `null` — not `undefined` and not an omitted key. `undefined` is dropped by JSON.stringify, so the PATCH body lacks the key, the update-body zod treats it as "no change", and drizzle `.set()` leaves the old value (silent no-op).
**Why:** `foo || undefined` is correct for CREATE (absent → column default / NULL) but WRONG for UPDATE — it makes fields impossible to blank. For update use `foo?.trim() ? foo.trim() : null`.
**How to apply:** the field must also be nullable in the *Update* OpenAPI schema (`type: ["string","null"]`), then re-run api-spec codegen. Input (create) schema can stay plain string.

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

## Paid-date gating is real, and the fetch window must be lookback-only
Eligibility ("paid on/after the start date", rule paid-date windows) is judged on a real `datePaid` (YYYY-MM-DD, derived from the newest Payment transaction; lexicographic compare, no Date parsing). `createdAt` is only a fallback for paid invoices with no payment transaction on record.
**Why:** Printavo can only be *paged* by creation order (VISUAL_ID desc), so the fetch cutoff must be the lookback alone — never `max(startDate, lookback)`. Clamping the fetch to the start date silently hides invoices created before it but paid after it, which DO qualify.
**How to apply:** any new scan/preview that filters by a payment-ish date must fetch by lookback and gate per-invoice on `datePaid`. Pending awards are re-validated each scan (stale ones deleted pending-only, under the advisory lock); awards whose invoice wasn't re-fetched are judged only on what the stored row can answer (paid-date checks), never deleted for mere absence from the fetch.

## Scan auto-creates customers — never require a pre-synced customer list
The rewards scan must not skip a paid invoice just because its contact email has no local customer row; it finds-or-creates the customer from the Printavo contact at award time (only for invoices that actually match a rule).
**Why:** requiring a prior bulk customer sync made every matching paid invoice silently vanish (no award, not in pipeline since PAID is excluded there) — the app looked broken with zero explanation.
**How to apply:** any new award/credit path that needs a customer row should reuse the find-or-create helper (lowercased/trimmed email, on-conflict-ignore + re-select for races). Caveat: some Printavo contacts have comma-separated multi-emails stored as one literal string — fine for matching, but credit emails to that string may bounce (email send is non-blocking by design).

## Pipeline forecast must assume a paid date
Unpaid/quote invoices have null `datePaid`, so rule paid-date windows would exclude ALL pipeline items if matched raw. The pipeline preview must match against a forecast invoice: `amountPaid = total`, `datePaid = max(today in shop TZ, rule.paidDateFrom)` — only an already-closed window (paidDateTo < today) excludes an unpaid order.
**Why:** Rule 3's July paid window emptied the Pipeline tab because forecast matching reused the strict scan matcher on null datePaid.
**How to apply:** Any new matcher condition keyed on payment state needs an explicit forecast semantics decision in `buildPipelinePreview`. Pipeline result is cached ~5min with single-flight + generation counter (`invalidatePipelineCache()` on rule/settings mutations) because the Printavo fetch takes ~45s throttled.
