import { BadRequestException } from '@nestjs/common';
import JSZip from 'jszip';
import type { UploadedFile } from '../documents/documents.service';
import { titleFromFileName } from './manifest';

/** Max reportable import items after ZIP expansion (files + per-entry errors). */
export const MAX_BULK_IMPORT_ITEMS = 200;
/** Per-extracted-file cap, matching the normal document upload limit. */
export const MAX_IMPORT_FILE_BYTES = 50 * 1024 * 1024;
/** Request-level uncompressed cap so one ZIP cannot exhaust API memory. */
export const MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES = 500 * 1024 * 1024;

type PreparedImportKind = 'file' | 'error';

export interface PreparedImportFile {
  kind: Extract<PreparedImportKind, 'file'>;
  file: UploadedFile;
  title: string;
  categoryPath: string | null;
  displayPath: string;
}

export interface PreparedImportError {
  kind: Extract<PreparedImportKind, 'error'>;
  fileName: string;
  categoryPath: string | null;
  displayPath: string;
  message: string;
}

export type PreparedImportItem = PreparedImportFile | PreparedImportError;

export interface PreparedBulkImport {
  items: PreparedImportItem[];
  sourceName: string | null;
}

interface ZipObjectWithPrivateData extends JSZip.JSZipObject {
  _data?: { uncompressedSize?: number; compressedSize?: number };
}

const ZIP_MIME_TYPES = new Set([
  'application/zip',
  'application/x-zip-compressed',
  'multipart/x-zip',
]);

const ZIP_EXTENSIONS = new Set(['zip']);

const SUPPORTED_ARCHIVE_EXTENSIONS = new Set([
  'pdf',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'txt',
  'md',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
]);

const MIME_BY_EXTENSION: Record<string, string> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain',
  md: 'text/markdown',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

/**
 * Converts browser files + optional browser relative paths into import items.
 * ZIP files are expanded safely; normal files are passed through with their path
 * metadata converted to a category path. All returned file items still flow
 * through DocumentsService for immutable storage/versioning.
 */
export async function prepareBulkImportFiles(
  files: UploadedFile[],
  relativePaths: string[] = [],
): Promise<PreparedBulkImport> {
  const items: PreparedImportItem[] = [];
  let uncompressedBytes = 0;

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    if (isZipFile(file)) {
      const expanded = await expandZipFile(file, uncompressedBytes);
      uncompressedBytes = expanded.uncompressedBytes;
      items.push(...expanded.items);
    } else {
      items.push(prepareDirectFile(file, relativePaths[index]));
      uncompressedBytes += file.buffer.length;
    }
    assertItemLimit(items.length);
  }

  return { items, sourceName: sourceNameFor(files) };
}

function prepareDirectFile(file: UploadedFile, relativePath: string | undefined): PreparedImportItem {
  if (relativePath && relativePath.trim()) {
    const normalized = normalizeImportPath(relativePath);
    if (!normalized.ok) {
      return {
        kind: 'error',
        fileName: file.originalname,
        categoryPath: null,
        displayPath: relativePath,
        message: normalized.message,
      };
    }
    return {
      kind: 'file',
      file,
      title: titleFromFileName(file.originalname),
      categoryPath: categoryPathFor(normalized.path),
      displayPath: normalized.path,
    };
  }
  return {
    kind: 'file',
    file,
    title: titleFromFileName(file.originalname),
    categoryPath: null,
    displayPath: file.originalname,
  };
}

async function expandZipFile(
  file: UploadedFile,
  startingUncompressedBytes: number,
): Promise<{ items: PreparedImportItem[]; uncompressedBytes: number }> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(file.buffer);
  } catch (err) {
    return {
      items: [
        {
          kind: 'error',
          fileName: file.originalname,
          categoryPath: null,
          displayPath: file.originalname,
          message: `ZIP archive could not be read: ${errorMessage(err)}`,
        },
      ],
      uncompressedBytes: startingUncompressedBytes,
    };
  }

  const items: PreparedImportItem[] = [];
  let total = startingUncompressedBytes;
  const entries = Object.values(zip.files).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.dir) continue;
    const unsafeName = entry.unsafeOriginalName ?? entry.name;

    // JSZip sanitizes traversal into `name` and exposes the raw source path here.
    // Treat that as an error item instead of trusting a rewritten path silently.
    if (entry.unsafeOriginalName && entry.unsafeOriginalName !== entry.name) {
      items.push({
        kind: 'error',
        fileName: unsafeName,
        categoryPath: null,
        displayPath: unsafeName,
        message: 'Skipped unsafe ZIP entry path.',
      });
      assertItemLimit(items.length);
      continue;
    }

    const normalized = normalizeImportPath(entry.name);
    if (!normalized.ok) {
      items.push({
        kind: 'error',
        fileName: unsafeName,
        categoryPath: null,
        displayPath: unsafeName,
        message: normalized.message,
      });
      assertItemLimit(items.length);
      continue;
    }
    if (shouldIgnorePath(normalized.path)) continue;

    const entryFileName = baseName(normalized.path);
    const extension = extensionOf(entryFileName);
    if (!SUPPORTED_ARCHIVE_EXTENSIONS.has(extension)) {
      items.push({
        kind: 'error',
        fileName: entryFileName,
        categoryPath: categoryPathFor(normalized.path),
        displayPath: normalized.path,
        message: `Unsupported file type ".${extension || '(none)'}" inside ZIP archive.`,
      });
      assertItemLimit(items.length);
      continue;
    }

    const expectedSize = uncompressedSize(entry);
    if (expectedSize !== null) {
      if (expectedSize > MAX_IMPORT_FILE_BYTES) {
        items.push({
          kind: 'error',
          fileName: entryFileName,
          categoryPath: categoryPathFor(normalized.path),
          displayPath: normalized.path,
          message: 'ZIP entry exceeds the 50 MB per-file import limit.',
        });
        assertItemLimit(items.length);
        continue;
      }
      if (total + expectedSize > MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES) {
        throw new BadRequestException('ZIP import exceeds the 500 MB uncompressed request limit.');
      }
    }

    let buffer: Buffer;
    try {
      // Stream-decompress with a hard byte cap so a zip bomb cannot expand into
      // memory even when the declared uncompressed size (checked above) is missing
      // or spoofed — the bound does not trust ZIP metadata.
      buffer = await readEntryBounded(entry, MAX_IMPORT_FILE_BYTES);
    } catch (err) {
      items.push({
        kind: 'error',
        fileName: entryFileName,
        categoryPath: categoryPathFor(normalized.path),
        displayPath: normalized.path,
        message:
          err instanceof ZipEntryTooLargeError
            ? 'ZIP entry exceeds the 50 MB per-file import limit.'
            : `ZIP entry could not be read: ${errorMessage(err)}`,
      });
      assertItemLimit(items.length);
      continue;
    }
    total += buffer.length;
    if (total > MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES) {
      throw new BadRequestException('ZIP import exceeds the 500 MB uncompressed request limit.');
    }

    items.push({
      kind: 'file',
      file: {
        originalname: entryFileName,
        mimetype: MIME_BY_EXTENSION[extension] ?? 'application/octet-stream',
        size: buffer.length,
        buffer,
      },
      title: titleFromFileName(entryFileName),
      categoryPath: categoryPathFor(normalized.path),
      displayPath: normalized.path,
    });
    assertItemLimit(items.length);
  }

  return { items, uncompressedBytes: total };
}

function isZipFile(file: UploadedFile): boolean {
  return ZIP_MIME_TYPES.has((file.mimetype ?? '').toLowerCase()) || ZIP_EXTENSIONS.has(extensionOf(file.originalname));
}

function normalizeImportPath(rawPath: string): { ok: true; path: string } | { ok: false; message: string } {
  const path = rawPath.replace(/\\/g, '/').trim();
  if (!path || path.includes('\0')) {
    return { ok: false, message: 'Import path is empty or invalid.' };
  }
  if (path.startsWith('/') || /^[A-Za-z]:\//.test(path)) {
    return { ok: false, message: 'Import path must be relative.' };
  }
  const parts = path.split('/').filter((part) => part.length > 0);
  if (parts.length === 0 || parts.some((part) => part === '.' || part === '..')) {
    return { ok: false, message: 'Import path contains unsafe path segments.' };
  }
  return { ok: true, path: parts.join('/') };
}

function shouldIgnorePath(path: string): boolean {
  const parts = path.split('/');
  return parts.some((part) => part === '__MACOSX' || part.startsWith('.')) || baseName(path) === 'Thumbs.db';
}

function categoryPathFor(path: string): string | null {
  const parts = path.split('/').slice(0, -1);
  return parts.length > 0 ? parts.join('/') : null;
}

function baseName(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
}

function extensionOf(fileName: string): string {
  const match = /\.([^.]+)$/.exec(fileName);
  return match ? match[1].toLowerCase() : '';
}

function uncompressedSize(entry: JSZip.JSZipObject): number | null {
  const value = (entry as ZipObjectWithPrivateData)._data?.uncompressedSize;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function assertItemLimit(count: number): void {
  if (count > MAX_BULK_IMPORT_ITEMS) {
    throw new BadRequestException(
      `Import contains ${count} files/errors after ZIP expansion; the maximum is ${MAX_BULK_IMPORT_ITEMS}.`,
    );
  }
}

function sourceNameFor(files: UploadedFile[]): string | null {
  if (files.length === 1 && isZipFile(files[0])) return files[0].originalname;
  if (files.length > 0 && files.every(isZipFile)) return `${files.length} ZIP archives`;
  return null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error && err.message ? err.message : 'unknown error';
}

/** Thrown when a ZIP entry's decompressed output exceeds the per-file cap. */
class ZipEntryTooLargeError extends Error {}

/**
 * Reads a ZIP entry's decompressed bytes with a hard cap, aborting as soon as the
 * output exceeds `maxBytes`. Unlike trusting `_data.uncompressedSize`, this bounds
 * ACTUAL memory use regardless of what the archive claims — the real zip-bomb
 * defense, independent of (possibly missing/spoofed) ZIP metadata.
 */
async function readEntryBounded(entry: JSZip.JSZipObject, maxBytes: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const stream = entry.nodeStream('nodebuffer');
    stream.on('data', (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        settled = true;
        stream.pause();
        reject(new ZipEntryTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    stream.on('error', (err: unknown) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    stream.on('end', () => {
      if (!settled) {
        settled = true;
        resolve(Buffer.concat(chunks));
      }
    });
  });
}
