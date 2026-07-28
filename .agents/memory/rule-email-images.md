---
name: Reward-rule email images
description: Invariants for the image-on-reward-rule feature and object storage posture in this app.
---

- Rule images live in private object storage but are flipped to ACL `visibility: "public"` at rule save time so email clients can fetch them anonymously via `/api/storage/objects/...`.
- **Why:** emails are read outside the app; the storage read route enforces ACL on anonymous reads (403 unless explicitly public), so forgetting the ACL flip makes images silently break in emails.
- **How to apply:** any new place that stores an object path for use in outbound email must (1) normalize/ACL it through the same `normalizeRuleImage`-style helper, and (2) only accept canonical `/objects/[A-Za-z0-9._/-]+` paths — both the rewards routes and `email.ts` validate this (defense in depth against markup injection into `<img src>`).
- This app deliberately has no auth layer; the upload endpoint follows the same unauthenticated posture as the rest of the API (documented in MINT_BUCKS_HANDOFF.md).
- Uppy v5 needed no React overrides here — the workspace is already on React 19.
