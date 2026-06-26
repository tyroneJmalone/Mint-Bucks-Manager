# Mint Bucks — Mint Printworks

A branded promotional credit system for Mint Printworks. Staff issue Mint Bucks credits to customers, track balances, generate QR-coded PDF certificates, record full/partial redemptions, and send automated emails.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 8080)
- `pnpm --filter @workspace/mint-bucks run dev` — run the frontend (port auto-assigned via PORT env)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/db run seed` — seed demo customers and credits

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string (provided by Replit) |
| `SMTP_HOST` | No | SMTP server host (e.g. `smtp.gmail.com`) |
| `SMTP_PORT` | No | SMTP port (default `587`) |
| `SMTP_USER` | No | SMTP username / Gmail address |
| `SMTP_PASS` | No | SMTP password or Gmail App Password |
| `FROM_EMAIL` | No | Sender address (default `noreply@mintprintworks.com`) |
| `APP_URL` | No | Public URL of the app — used in email certificate links |

**Note:** Email is fully built but non-blocking. If SMTP vars are not set, email content is logged and the server continues normally. To enable real email sending via Gmail: create a Google App Password at myaccount.google.com/apppasswords and set all five SMTP_* + FROM_EMAIL vars as Replit secrets.

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5 (port 8080), pino logging
- DB: PostgreSQL + Drizzle ORM (`lib/db`)
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec at `lib/api-spec/openapi.yaml`)
- Build: esbuild (CJS bundle)
- Frontend: React + Vite + Wouter + TanStack Query
- Charts: Recharts
- PDF: pdfkit + qrcode
- Email: Nodemailer

## Where things live

- `lib/api-spec/openapi.yaml` — single source of truth for all API shapes
- `lib/db/src/schema/index.ts` — DB schema (customers, credits, redemptions)
- `artifacts/api-server/src/routes/` — Express route handlers
- `artifacts/api-server/src/lib/email.ts` — email templates and sending
- `artifacts/api-server/src/lib/certificate.ts` — PDF certificate + QR code generation
- `artifacts/mint-bucks/src/pages/` — all React pages
- `artifacts/mint-bucks/src/App.tsx` — router + layout

## Architecture decisions

- **Credit codes** use format `MB-XXXXXXXX` (8-char uppercase hex slice of UUID) — human-readable, scannable
- **Email is non-blocking**: all email functions catch errors and log them; server never crashes on SMTP failure
- **`@swc/helpers` must be a runtime dep** of api-server — pdfkit→fontkit→brotli requires it at runtime even though esbuild externalizes it; omitting it causes startup crash
- **Binary endpoints** (QR, certificate) are plain `<img src>` / `<a href>` URLs — not React Query hooks — because they return binary content
- **Drizzle array queries** use `inArray(col, arr)` — never raw `sql\`ANY()\`` template which fails to serialize arrays at runtime

## Product

Staff portal for managing Mint Bucks store credits:
- **Dashboard**: outstanding balance, monthly issuance, redemption rate, recent activity feed, expiring-soon alert
- **Customers**: add/search/delete customers with credit summaries
- **Mint Bucks**: issue credits with optional expiry and notes; view/void individual credits
- **Credit Detail**: QR code, balance progress bar, in-page redemption form, redemption history
- **Redemptions**: full log of all redemptions across all customers
- **Reports**: credits-over-time chart, top customers, redemption rate trend
- **PDF Certificates**: downloadable branded certificate with QR code for each credit
- **Emails**: issuance confirmation, redemption receipt, manual reminder

## User preferences

_None recorded yet._

## Gotchas

- Always run `pnpm --filter @workspace/db run push` after changing `lib/db/src/schema/index.ts`
- Always run `pnpm --filter @workspace/api-spec run codegen` after changing `lib/api-spec/openapi.yaml` to regenerate hooks and Zod schemas
- Rebuild api-server after code changes: `pnpm --filter @workspace/api-server run build` then restart the workflow

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
