---
name: Clerk staff-access platform setup
description: Non-code production controls for Replit-managed Clerk staff access
---
Replit-managed Clerk has separate Development and Production user stores and provider configuration. Google sign-in must be confirmed in each environment through Users & Auth; a successful Development login does not prove Production is configured.

**Why:** App metadata enforces Mint Bucks roles, but Clerk provider availability and Replit Publishing visibility are platform controls. The agent can implement and test the code without being able to toggle those UI settings.

**How to apply:** Before a staff-auth release, confirm Google in both Auth environments, keep the canonical production app origin configured for invitation callbacks, and deliberately choose the published app visibility in Publishing settings rather than assuming preview settings carry over.