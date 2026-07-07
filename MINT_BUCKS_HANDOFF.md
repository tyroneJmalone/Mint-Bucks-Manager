# Mint Bucks — Technical Handoff / Integration Context

**Purpose of this document:** Mint Bucks is one of four Printavo-connected apps being considered for consolidation into a single dashboard. This doc gives another agent enough context to understand how Mint Bucks is built, what it does, and what matters when combining it with sibling apps tied to the same Printavo account.

---

## 1. What the App Does

Mint Bucks is a **promotional store-credit system** for Mint Printworks (a screen-printing shop that runs on Printavo). It:

- Issues store credits ("Mint Bucks") to customers — manually or automatically via a rules-based **rewards engine** that scans paid Printavo invoices (e.g., "spend $1,000, get $100").
- Tracks credit balances, partial redemptions, and expirations.
- Generates **PDF gift certificates** with QR codes linking to a public balance-check page.
- Emails customers on issuance, redemption, expiry reminders, and when a new Printavo order comes in for a customer with unused credit ("you have credit — apply it!").
- Provides an admin dashboard with reporting (issuance/redemption trends, top customers, expiring credits, activity log).

Admin user: Tyler (owner). No multi-user auth currently — it's a single-tenant internal tool.

## 2. Tech Stack & Architecture

**pnpm monorepo** with contract-first API design:

| Package | Role |
|---|---|
| `artifacts/api-server` | Express 5 backend (TypeScript, esbuild). Serves all business logic under `/api`, port from `PORT` env (8080 in dev). |
| `artifacts/mint-bucks` | React + Vite + Tailwind + shadcn/ui admin frontend. Talks to API via generated React Query hooks. |
| `lib/db` | Drizzle ORM schemas + migrations for PostgreSQL (Replit-managed, `DATABASE_URL`). |
| `lib/api-spec` | `openapi.yaml` — **single source of truth** for the API contract. Orval codegen. |
| `lib/api-zod` | Generated Zod schemas — used by the API server for request/response validation. |
| `lib/api-client-react` | Generated React Query hooks — used by the frontend. |

**Codegen workflow:** edit `openapi.yaml` → `pnpm --filter @workspace/api-spec run codegen` → regenerates Zod + React client. Backend and frontend never hand-write API types.

## 3. Database Schema (PostgreSQL, Drizzle)

- **`customers`** — local customer records: `id`, `name`, `email` (unique), `phone`, `company_name`. Populated manually or bulk-synced from Printavo contacts.
- **`credits`** — `id`, `customerId`, `code` (unique, human-shareable), `amount`, `amountRemaining`, `status` (`active` / `partially_redeemed` / `fully_redeemed` / `expired` / `void`), `sourceRuleId` (if reward-generated), `expiresAt`.
- **`redemptions`** — `creditId`, `customerId`, `amountApplied`, `invoiceRef` (Printavo reference), `redeemedAt`.
- **`reward_rules`** — `name`, `enabled`, `rewardType` (`flat` / `percent_paid` / `percent_total` / `tiered`), `rewardParams` (JSON), `conditions` (JSON: order tags, status, total min/max), `startsAt`/`endsAt`.
- **`reward_awards`** — **dedup ledger** preventing double-awards. `ruleId`, `printavoInvoiceId` (Printavo *internal* id, see §5), `printavoVisualId`, `amount`, `status` (`processing` → `pending` → `issued` / `rejected`). **Unique on `(ruleId, printavoInvoiceId)`.**
- **`settings`** — key-value config store. Sensitive values (Printavo API key) are **AES-256-GCM encrypted at rest**, keyed by `SETTINGS_ENCRYPTION_KEY` env secret.
- **`notification_log`** — tracks credit-available emails per order. Unique on `(customerId, printavoOrderId)` to prevent duplicate emails.

## 4. API Surface (all under `/api`)

- **`/credits`** — CRUD + `POST /:id/redeem` (apply to invoice), `POST /:id/remind` (email reminder), `GET /check/:code` (public balance check), `GET /:id/qr` (QR PNG), `GET /:id/certificate` (PDF).
- **`/customers`** — CRUD + per-customer credit history + balance stats.
- **`/rewards`** — settings (enabled, mode `auto`|`approve`, annual budget limit), rules CRUD, awards ledger, `POST /awards/:id/approve|reject`, `POST /scan` (manual scan trigger), `GET /pipeline` (forecast of potential awards from open quotes + unpaid invoices).
- **`/printavo`** — `POST /test` (credential check), `POST /sync-customers` (bulk contact import), `POST /poll` (manual poll trigger), `GET /order/:orderNum`, `GET /notification-log`.
- **`/settings/printavo`** — get/update credentials + polling interval.
- **`/reports`** — summary KPIs, credits-over-time, top customers, expiring soon, activity feed.
- **`GET /healthz`**.

## 5. Printavo Integration (critical for consolidation)

All Printavo access goes through one module (`artifacts/api-server/src/lib/printavo.ts`) against **GraphQL API v2** — single endpoint `POST https://www.printavo.com/api/v2`.

**Auth:** HTTP headers `email` + `token` (the account API key). Stored encrypted in the `settings` table; also available as env secrets `PRINTAVO_EMAIL` / `PRINTAVO_API_KEY`.

**Hard-won API quirks (verified against the live API — trust these):**

1. **Rate limit: 10 requests per 5 seconds, account-wide.** Mint Bucks serializes all GraphQL calls through a promise gate with a **≥620ms minimum interval** between requests, plus a one-shot retry after a 5.2s cooldown on HTTP 429. ⚠️ **This limit is shared by every app using the same Printavo account.** Four apps polling independently *will* collide with 429s. A combined app should route all Printavo traffic through a single throttled client — this is one of the strongest arguments for consolidation.
2. **Quotes never appear in the `invoices` query.** Printavo's `invoices` GraphQL query only returns orders after quote approval. To see pre-approval work you must query `orders` (a Quote/Invoice union) and filter on `__typename === "Quote"`. Mint Bucks' pipeline feature depends on this.
3. **Two IDs per order:** the internal numeric `id` (e.g. `23592196`, stable, used in API lookups and stored in `reward_awards.printavo_invoice_id`) and the `visualId` (e.g. `22375`, the human-facing order number shown in the Printavo UI). Always store the internal id; display the visualId.
4. **Two URLs per order:** `url` = merchant-side page, deterministic `https://www.printavo.com/invoices/{internalId}` for **both** quotes and invoices; `publicUrl` = customer-facing hashed link (`https://mintprintworks.printavo.com/invoice/{hash}`). Deep links in the admin UI use the merchant URL, constructed from the internal id.
5. **Queries used:** `contacts` (customer sync), `invoices` filtered by `paymentStatus` (`PAID` for the rewards scan; `UNPAID`/`PARTIAL_PAYMENT` for pipeline), `orders` sorted by `VISUAL_ID` desc (open quotes for pipeline).
6. **No webhooks are used** — Printavo state is pulled by polling (see §6). (Printavo v2 does offer some webhook support; Mint Bucks predates evaluating it.)

## 6. Background Jobs (in-process poller)

A `setInterval` loop inside the API server (interval from `printavo_polling_interval` setting, default 15 min) does three things each tick:

1. **Rewards scan** — fetch recently PAID invoices, match against enabled `reward_rules`, insert `reward_awards`. In `auto` mode credit is issued immediately; in `approve` mode awards queue as `pending` for Tyler to approve in the dashboard. An **annual budget cap** is enforced atomically using a Postgres advisory lock (`pg_advisory_xact_lock`) so concurrent scans can't overspend.
2. **Order notifications** — fetch recent orders; if the customer has active credit and no `notification_log` row for that order, claim the slot and send a "you have credit" email.
3. **Stale-state cleanup** — resets `processing` awards / `pending` notifications older than 10 min (crash recovery).

## 7. Email

Outbound email via **Resend** through Replit's connector integration (`@replit/connectors-sdk`). Templates: credit issued, credit redeemed, expiry reminder, order notification. Sender address from `FROM_EMAIL`.

## 8. Frontend Pages

`Dashboard` (KPIs + activity) · `Customers` / `CustomerDetail` (CRM + sync from Printavo) · `Credits` / `CreditDetail` / `IssueCredit` · `Redemptions` · `Rewards` (settings, rules, pending-approval queue, pipeline forecast, history — Printavo order numbers deep-link to the merchant order page) · `Reports` · `Settings` (Printavo creds + polling) · `CheckCredit` (public, QR-reachable balance checker).

## 9. Env Vars / Secrets (names only)

`DATABASE_URL`, `SETTINGS_ENCRYPTION_KEY` (32-byte hex for AES-GCM), `PRINTAVO_EMAIL`, `PRINTAVO_API_KEY`, `FROM_EMAIL`, `PORT`, `APP_URL` / `REPLIT_DEV_DOMAIN` (link + QR generation).

## 10. Consolidation Considerations (from this app's perspective)

- **Single throttled Printavo client is non-negotiable.** The 10-req/5s account-wide limit means the combined dashboard needs one shared gateway module (Mint Bucks' throttle + 429-retry logic is a proven starting point).
- **The dedup ledgers are load-bearing.** `reward_awards (ruleId, printavoInvoiceId)` and `notification_log (customerId, printavoOrderId)` unique constraints are what make polling idempotent and safe. Preserve them (or an equivalent) through any migration.
- **Credits are the system of record here, not Printavo.** Balances, redemptions, and expiry live only in this Postgres DB. Merging apps must not lose this ledger; redemptions reference Printavo invoices but Printavo knows nothing about credit balances.
- **Contract-first pattern travels well.** If the combined dashboard keeps the OpenAPI → Orval (Zod + React Query) pipeline, Mint Bucks' endpoints can be merged into a unified spec with minimal frontend rework.
- **Poller consolidation:** each app running its own poll loop multiplies API traffic. A combined app should have one scheduler that fans out to each feature module.
- **Auth gap:** Mint Bucks has no login layer. A combined dashboard will likely want one; nothing in Mint Bucks conflicts with adding auth in front.
