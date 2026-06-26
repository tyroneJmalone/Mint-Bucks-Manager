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
