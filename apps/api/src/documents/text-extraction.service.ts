import { Injectable, Logger } from '@nestjs/common';
import type { ExtractionStatus } from '@policymanager/shared';
import * as mammoth from 'mammoth';
// pdf-parse is pinned to the v1 line ON PURPOSE. v2 pulls in pdfjs-dist v5,
// whose Node build eagerly loads @napi-rs/canvas (to polyfill DOMMatrix /
// ImageData / Path2D). That package ships a prebuilt Skia binary requiring AVX2,
// which the deployment host's CPU lacks — the process died with SIGILL (exit
// 132) during Nest bootstrap, before any JS error could be logged. v1 bundles
// its own pdf.js and has no native dependency at all. See docs/runbooks.
import pdfParse from 'pdf-parse';
import { OcrService } from './ocr.service';

export type ExtractorKind = 'pdf' | 'docx' | 'text' | 'image' | 'none';

export interface TextExtractionResult {
  text: string;
  status: ExtractionStatus;
  ocrApplied: boolean;
  error: string | null;
}

/** Upper bound on stored extracted text to keep rows/search index sane. */
export const MAX_EXTRACTED_TEXT_CHARS = 1_000_000;

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function extensionOf(fileName: string): string {
  const idx = fileName.lastIndexOf('.');
  return idx >= 0 ? fileName.slice(idx + 1).toLowerCase() : '';
}

/**
 * Pure dispatch: decides which extraction strategy applies from the mime type
 * and/or file extension. Extension is a fallback because browsers/importers
 * frequently send `application/octet-stream`.
 *
 * Note: legacy binary `.doc` (application/msword) is intentionally unsupported
 * (mammoth handles only OpenXML `.docx`) and returns `none` — a rendition step
 * (Gotenberg) is the future path for those formats.
 */
export function selectExtractor(mimeType: string, fileName: string): ExtractorKind {
  const mime = (mimeType || '').toLowerCase();
  const ext = extensionOf(fileName || '');

  if (mime === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (mime === DOCX_MIME || ext === 'docx') return 'docx';
  if (mime.startsWith('text/') || ['txt', 'md', 'markdown', 'csv'].includes(ext)) return 'text';
  if (mime.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'tif', 'tiff'].includes(ext)) {
    return 'image';
  }
  return 'none';
}

/**
 * Extracts plain text from an uploaded document for the API/search (RAG-ready).
 *
 * Hard contract: extraction is best-effort and MUST NEVER crash an upload — any
 * parser failure is logged and yields an empty string so the version still
 * stores. Access to the extracted text later obeys the same scope as the file
 * download (AGENTS.md §8).
 */
@Injectable()
export class TextExtractionService {
  private readonly logger = new Logger(TextExtractionService.name);

  constructor(private readonly ocr?: OcrService) {}

  async extract(buffer: Buffer, mimeType: string, fileName: string): Promise<string> {
    const result = await this.extractWithStatus(buffer, mimeType, fileName);
    return result.text;
  }

  async extractWithStatus(
    buffer: Buffer,
    mimeType: string,
    fileName: string,
  ): Promise<TextExtractionResult> {
    const kind = selectExtractor(mimeType, fileName);
    try {
      switch (kind) {
        case 'pdf': {
          const pdf = await this.extractPdf(buffer);
          const text = this.cap(pdf.text);
          if (!this.ocr?.shouldOcrPdfText(text)) {
            return done(text, false);
          }
          return this.ocrResult(buffer, mimeType, fileName, pdf.pages);
        }
        case 'docx': {
          const { value } = await mammoth.extractRawText({ buffer });
          return done(this.cap(value ?? ''), false);
        }
        case 'text':
          return done(this.cap(buffer.toString('utf8')), false);
        case 'image':
          return this.ocrResult(buffer, mimeType, fileName);
        default:
          return skipped('File type is not supported for text extraction.');
      }
    } catch (err) {
      this.logger.warn(`Text extraction failed for "${fileName}" (${kind}): ${(err as Error).message}`);
      if (kind === 'pdf') {
        return this.ocrResult(buffer, mimeType, fileName);
      }
      return failed((err as Error).message);
    }
  }

  private async ocrResult(
    buffer: Buffer,
    mimeType: string,
    fileName: string,
    pages?: number | null,
  ): Promise<TextExtractionResult> {
    if (!this.ocr) return skipped('OCR is disabled or OCR_ENDPOINT is not configured.');
    const skip = this.ocr.skipReasonFor(buffer, pages);
    if (skip) return skipped(skip.reason);

    try {
      const ocr = await this.ocr.extract(buffer, mimeType, fileName);
      const text = this.cap(ocr.text ?? '');
      return text.length > 0 ? done(text, true) : skipped('OCR completed but found no text.');
    } catch (err) {
      this.ocr?.logFailure(fileName, err);
      return failed((err as Error).message);
    }
  }

  private async extractPdf(buffer: Buffer): Promise<{ text: string; pages: number | null }> {
    // Preserve PAGE BOUNDARIES with a form-feed (\f) between pages so the
    // structure-aware chunker (RAG Phase 2) can attribute each chunk to a page
    // range for citations. v1 has no per-page result field, so we capture each
    // page through its `pagerender` hook instead; the hook's return value is
    // what v1 concatenates into `data.text`, so returning the text keeps that
    // flat fallback intact for the single-page case.
    const perPage: string[] = [];
    const data = await pdfParse(buffer, {
      pagerender: async (pageData: {
        getTextContent: () => Promise<{ items: Array<{ str?: string }> }>;
      }) => {
        const content = await pageData.getTextContent();
        const text = content.items.map((item) => item.str ?? '').join(' ');
        perPage.push(text);
        return text;
      },
    });

    const pages = typeof data.numpages === 'number' ? data.numpages : null;
    // Multi-page: join with \f to keep page geometry. Single page (or no pages
    // captured): fall back to the flat text — pageStart/pageEnd then degrade to
    // null downstream, which is safe for non-paginated docs.
    const text = perPage.length > 1 ? perPage.join('\f') : (data.text ?? '');
    return { text, pages };
  }

  private cap(text: string): string {
    return text.length > MAX_EXTRACTED_TEXT_CHARS ? text.slice(0, MAX_EXTRACTED_TEXT_CHARS) : text;
  }
}

function done(text: string, ocrApplied: boolean): TextExtractionResult {
  return { text, status: 'done', ocrApplied, error: null };
}

function skipped(reason: string): TextExtractionResult {
  return { text: '', status: 'skipped', ocrApplied: false, error: reason };
}

function failed(message: string): TextExtractionResult {
  return { text: '', status: 'failed', ocrApplied: false, error: message };
}
