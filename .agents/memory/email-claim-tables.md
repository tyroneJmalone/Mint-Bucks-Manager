---
name: Email send claim tables
description: Pattern for exactly-once automated emails (notification_log, reminder_sends)
---
Rule: any automated email pass must claim atomically via insert-with-unique + ON CONFLICT DO NOTHING, mark sent on success, delete claim on failure, AND sweep stale "pending" claims (age-bounded) at pass start.

**Why:** review caught that a crash between claim and send permanently blocks that send if pendings are never released; notification_log deletes on failure, reminder_sends adds a 30-min stale sweep.

**How to apply:** copy the reminder_sends pattern (poller.ts runReminderPass) for any new scheduled email. Also: "credits with balance" means status IN (active, partially_redeemed), not just active; and schedule steps need a DB unique constraint (rule_reminders unique rule/anchor/offset) to prevent duplicate sends.

Custom email verbiage: plain-text templates with {{placeholders}} stored per rule (issued) / per reminder step / in settings (manual issues); rendered by renderTemplate/renderBodyHtml in email.ts, which HTML-escape both template and values — keep any new template path going through those helpers.
