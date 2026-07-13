# ADR 0002 — OnlyOffice edition & licensing

Status: Accepted

## Context

We need in-browser editing of Office documents (docx/xlsx/pptx). We integrated OnlyOffice Docs (`onlyoffice/documentserver`).

## Decision

Use **OnlyOffice Docs Community Edition** (AGPL v3, free, self-hosted).

Rationale:
- Free; no per-seat cost for a single small clinic.
- AGPL copyleft obligations trigger only on **distribution to third parties**; internal use by the clinic does not.
- The ~20 concurrent-editing-connection cap is not a constraint at clinic scale (PDF *viewing* via Gotenberg renditions does not consume connections).

## Alternatives / escalation path

- **OnlyOffice Enterprise / Developer** (paid) — needed only for >20 concurrent editors, official support/SLA, white-labeling, or redistribution. Contact onlyoffice.com sales for a current quote (priced by simultaneous connections).
- **Collabora Online (CODE)** — comparable free/paid model.
- **Drop the Office server entirely** — viewing still works via the Gotenberg PDF rendition; users would download → edit locally → re-upload (new version). Loses in-browser Office editing only.

## Consequences

- No licensing cost for v1.
- If concurrent-editing demand grows or a support SLA is required, revisit with Enterprise or Collabora.
