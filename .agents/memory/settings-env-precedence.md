---
name: Settings vs env-var precedence
description: DB-saved settings must win over environment variables, or stale env vars silently shadow user updates.
---

Rule: `getSetting()` reads the database first; `process.env[KEY]` is only a fallback when no DB row/value exists.

**Why:** A stale `PRINTAVO_API_KEY` env var (baked into the environment from an early setup, not present in Replit env system or any config file) silently overrode freshly saved tokens — the user updated the token in Settings but the app kept sending the old expired one. Diagnosed by decrypting the stored setting and calling Printavo directly (worked) while the app path failed.

**How to apply:** Any new setting readable from both env and DB must prefer the DB value. When debugging "saved but not taking effect" credentials, check `env | grep <PREFIX>` for shadowing overrides first.
