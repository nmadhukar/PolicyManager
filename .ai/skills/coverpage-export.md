# Skill: Cover Page Export

## Purpose

Generate compliance cover pages without mutating controlled document versions.

## Use When

- Adding cover page generation.
- Adding PDF export.
- Updating approval evidence.

## Procedure

1. Load document metadata.
2. Load exact document version.
3. Load approval/attestation chain.
4. Load revision history.
5. Generate cover page.
6. Prepend or package export without changing source bytes.
7. Audit export/download.
8. Test output metadata.

## Required Content

- Title.
- Document number.
- Version.
- Effective date.
- Owner.
- Status.
- Review cadence.
- Next review date.
- Approval chain.
- Revision history.

## Optional Content

- Recent access summary, only if enabled by config.

## Output

- Export behavior.
- PDF verification.
- Audit proof.
