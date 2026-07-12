# Skill: Review Workflow

## Purpose

Implement and verify scheduled policy review behavior.

## Use When

- Adding review schedules.
- Adding review tasks.
- Adding reminders.
- Adding overdue logic.

## Procedure

1. Define cadence.
2. Define reviewer assignment.
3. Define due date and lead time.
4. Freeze time in tests.
5. Create due review task.
6. Send or log reminder.
7. Complete review.
8. Advance next review date.
9. Audit the state change.

## Required Edge Cases

- Past due date.
- Due within lead window.
- Already has open review task.
- Reviewer removed or inactive.
- Custom cadence.
- Grace period.

## Output

- Review state behavior.
- Date tests.
- Reminder proof.
- Audit proof.
