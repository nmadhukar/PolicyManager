import { BadRequestException } from '@nestjs/common';
import { parse } from 'csv-parse/sync';
import {
  ACCESS_LEVELS,
  IMPORT_MANIFEST_COLUMNS,
  REVIEW_CADENCES,
  type AccessLevel,
  type ReviewCadence,
} from '@policymanager/shared';

/**
 * A single VALID manifest row, normalized. `rowNumber` is the 1-based position
 * among data rows (the header is not counted), which is what the import report
 * surfaces. `tags` is always an array (possibly empty). Optional string cells are
 * `undefined` when blank so downstream code can treat "absent" uniformly.
 */
export interface ManifestRow {
  rowNumber: number;
  title: string;
  fileName?: string;
  category?: string;
  documentNumber?: string;
  owner?: string;
  tags: string[];
  accessLevel?: AccessLevel;
  reviewCadence?: ReviewCadence;
  description?: string;
}

/** A row that failed VALIDATION (kept out of `rows`, reported as an error item). */
export interface ManifestRowError {
  rowNumber: number;
  title: string | null;
  fileName: string | null;
  documentNumber: string | null;
  message: string;
}

/** The result of parsing a manifest buffer: detected header + valid + invalid rows. */
export interface ParsedManifest {
  /** The raw (trimmed) header names as they appeared in the file. */
  columns: string[];
  rows: ManifestRow[];
  errors: ManifestRowError[];
}

/** Hard cap so a runaway manifest cannot exhaust memory / the request budget. */
export const MAX_MANIFEST_ROWS = 5000;

/** Canonical column name keyed by its lower-cased form (case-insensitive headers). */
const CANONICAL_BY_LOWER = new Map(
  IMPORT_MANIFEST_COLUMNS.map((c) => [c.toLowerCase(), c] as const),
);

/** Maps a raw header cell to its canonical column name, or keeps it as-is. */
function normalizeHeader(raw: string): string {
  const trimmed = String(raw ?? '').trim();
  return CANONICAL_BY_LOWER.get(trimmed.toLowerCase()) ?? trimmed;
}

/** Trims a cell; returns undefined for blank/whitespace-only cells. */
function clean(value: string | undefined): string | undefined {
  const trimmed = (value ?? '').trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Splits a single manifest tag cell into distinct tags. Because the field
 * delimiter is a comma, tags inside one cell are separated by `;` or `|`. Order is
 * preserved and duplicates are removed.
 */
export function parseTags(raw: string | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const part of raw.split(/[;|]/)) {
    const tag = part.trim();
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out;
}

/**
 * Splits a `/`-separated category path into ordered, non-empty segment names
 * (e.g. `"Policies & Procedures/Clinical"` → `["Policies & Procedures", "Clinical"]`).
 * Pure so both the parser and the category resolver can share it.
 */
export function splitCategoryPath(path: string | undefined): string[] {
  if (!path) return [];
  return path
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Parses a CSV manifest buffer into valid rows + per-row validation errors.
 *
 * Whole-file problems throw {@link BadRequestException} (unparseable CSV, a missing
 * required `title` column, or exceeding {@link MAX_MANIFEST_ROWS}); per-row problems
 * (blank title, invalid accessLevel/reviewCadence) are collected as `errors` so one
 * bad row never discards the good ones. Header names are matched case-insensitively
 * and unknown columns are ignored.
 */
export function parseManifest(buffer: Buffer): ParsedManifest {
  let columns: string[] = [];
  let records: Record<string, string>[];
  try {
    records = parse(buffer, {
      bom: true,
      columns: (header: string[]) => {
        columns = header.map((h) => String(h ?? '').trim());
        return header.map((h) => normalizeHeader(h));
      },
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
    }) as Record<string, string>[];
  } catch (err) {
    throw new BadRequestException(`Manifest is not valid CSV: ${(err as Error).message}`);
  }

  const normalizedColumns = columns.map((c) => normalizeHeader(c));
  if (!normalizedColumns.includes('title')) {
    throw new BadRequestException('Manifest must include a "title" column.');
  }
  if (records.length > MAX_MANIFEST_ROWS) {
    throw new BadRequestException(
      `Manifest has ${records.length} rows; the maximum is ${MAX_MANIFEST_ROWS}.`,
    );
  }

  const rows: ManifestRow[] = [];
  const errors: ManifestRowError[] = [];

  records.forEach((rec, index) => {
    const rowNumber = index + 1;
    const title = (rec.title ?? '').trim();
    const fileName = clean(rec.fileName);
    const documentNumber = clean(rec.documentNumber);

    if (!title) {
      errors.push({
        rowNumber,
        title: null,
        fileName: fileName ?? null,
        documentNumber: documentNumber ?? null,
        message: 'Missing required "title".',
      });
      return;
    }

    const accessLevelRaw = clean(rec.accessLevel);
    if (accessLevelRaw && !ACCESS_LEVELS.includes(accessLevelRaw as AccessLevel)) {
      errors.push({
        rowNumber,
        title,
        fileName: fileName ?? null,
        documentNumber: documentNumber ?? null,
        message: `Invalid accessLevel "${accessLevelRaw}". Use one of: ${ACCESS_LEVELS.join(', ')}.`,
      });
      return;
    }

    const reviewCadenceRaw = clean(rec.reviewCadence);
    if (reviewCadenceRaw && !REVIEW_CADENCES.includes(reviewCadenceRaw as ReviewCadence)) {
      errors.push({
        rowNumber,
        title,
        fileName: fileName ?? null,
        documentNumber: documentNumber ?? null,
        message: `Invalid reviewCadence "${reviewCadenceRaw}". Use one of: ${REVIEW_CADENCES.join(', ')}.`,
      });
      return;
    }

    rows.push({
      rowNumber,
      title,
      fileName,
      category: clean(rec.category),
      documentNumber,
      owner: clean(rec.owner),
      tags: parseTags(rec.tags),
      accessLevel: accessLevelRaw as AccessLevel | undefined,
      reviewCadence: reviewCadenceRaw as ReviewCadence | undefined,
      description: clean(rec.description),
    });
  });

  return { columns, rows, errors };
}

/**
 * Derives a document title from an uploaded file's name for the manifest-less bulk
 * mode: takes the base name and strips a single trailing extension. Falls back to
 * the original name when stripping would leave nothing.
 */
export function titleFromFileName(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  const withoutExt = base.replace(/\.[^.]+$/, '').trim();
  return withoutExt.length > 0 ? withoutExt : base;
}
