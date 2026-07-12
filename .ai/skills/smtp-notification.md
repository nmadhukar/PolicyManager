# Skill: SMTP Notification

## Purpose

Add review reminder and notification email behavior safely.

## Use When

- Adding SMTP config.
- Sending review reminders.
- Logging notification attempts.

## Procedure

1. Keep secrets in env/secret store, not plaintext DB.
2. Store safe SMTP configuration only.
3. Send through a service abstraction.
4. Log notification attempt in `NotificationLog`.
5. Test locally with MailHog.
6. Add admin docs for SMTP setup.
7. Add user/admin guide updates for reminder behavior.

## Required Tests

- Successful send logs success.
- Failed send logs failure.
- Disabled SMTP does not send.
- Unauthorized user cannot change SMTP config.
