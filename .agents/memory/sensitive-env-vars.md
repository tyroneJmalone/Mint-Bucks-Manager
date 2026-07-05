---
name: Sensitive env vars must be Secrets, not shared env
description: How to store keys/tokens/encryption keys in this repl without leaking them into git.
---

# Sensitive values → Replit Secrets, never setEnvVars

`setEnvVars({ ..., environment: "shared" })` writes to `[userenv.shared]` in **`.replit`,
which is git-tracked**. Anything put there (API keys, tokens, encryption keys) is committed
in plaintext and leaks to anyone who forks/clones/shares the repl.

**Rule:** for any sensitive value, use `requestEnvVar({ requestType: "secret", ... })` so it
becomes a global Replit **Secret** (encrypted, not committed). Secrets are exposed as env
vars at runtime in both dev and prod, so `process.env.FOO` still works.

**Why this bit us:** `SETTINGS_ENCRYPTION_KEY` (the AES key that encrypts the Printavo API
token in the `settings` table) was created via `setEnvVars` and ended up committed in
`.replit` — defeating the encryption. Fix was to delete it from shared env and re-request it
as a Secret. Rotation was safe only because the `settings` table held no encrypted values
yet (Printavo creds came from env-override secrets). If encrypted rows exist, rotating the
key makes them undecryptable — re-save those secrets after rotating.

**How to apply:** if you catch a secret in `[userenv.shared]`, `deleteEnvVars` it from
`shared` and `requestEnvVar` it as a `secret`.
