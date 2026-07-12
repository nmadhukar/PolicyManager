# Skill: Import Consolidation

## Purpose

Safely import scattered existing documents into PolicyManager.

## Use When

- Adding bulk upload.
- Adding CSV manifest import.
- Migrating file-share documents.

## Procedure

1. Define manifest format.
2. Validate every row.
3. Resolve category and owner.
4. Detect duplicates by checksum and document number.
5. Import valid rows.
6. Report invalid rows without losing valid imports.
7. Write audit events.
8. Produce import summary.

## Manifest Columns

```text
filepath,title,category,documentNumber,owner,reviewCadence,effectiveDate,tags
```

## Output

- Import summary.
- Error report.
- Duplicate report.
- Audit proof.
