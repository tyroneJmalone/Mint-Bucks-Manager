---
name: pdfkit + esbuild bundling
description: Why bundling pdfkit with esbuild breaks PDF generation at runtime, and how to fix it.
---

# pdfkit + esbuild bundling

pdfkit loads its built-in font metric (`.afm`) files (Helvetica, Courier, etc.)
from `<bundle dir>/data` at runtime via `fs`. esbuild only bundles JS, so these
data files are left behind and `new PDFDocument()` / `.font(...)` throws at
runtime — surfacing as an HTTP 500 from the certificate/PDF endpoint, even though
the build and typecheck pass cleanly.

**The rule:** any service that bundles pdfkit with esbuild must copy pdfkit's
`data/` directory into the output `dist/` as a post-build step. Resolve it via
`require.resolve("pdfkit")` → `path.dirname(entry)/data` (do not hardcode the
`.pnpm` hash path). Make the copy failure fatal at build time rather than a
warning — a missing AFM dir is a guaranteed runtime break, so it should fail the
build, not ship a broken bundle.

**Why:** this is invisible in dev (where pdfkit resolves from node_modules) and
only bites in the bundled/deployed path, so it's easy to ship and only discover
in production.

**How to apply:** see `copyPdfkitData()` in `artifacts/api-server/build.mjs`.
The same pattern applies to any other lib that reads sibling data files at
runtime (e.g. fontkit, sharp's vendored binaries) when bundled.
