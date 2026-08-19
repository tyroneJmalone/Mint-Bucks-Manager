---
name: Dev/prod settings gap
description: Published app has a separate DB; settings edited in preview never reach production
---
The published Mint Bucks app uses its own production database. Email templates, rule conditions, and other settings edited in the workspace preview do NOT carry over on publish — the user perceived this as "republish reset my settings" (Aug 2026). Production data persists across republishes; nothing is wiped.

**Why:** Replit publish updates code only; each environment keeps its own DB. Agent has read-only access to prod DB — cannot sync settings for the user.

**How to apply:** If the user reports settings "reset" after publishing, check prod DB read-only first; the fix is re-entering in the live app (or an export/import feature — user declined building one, prefers manual re-entry).
