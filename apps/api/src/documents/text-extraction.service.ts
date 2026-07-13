import { Injectable, Logger } from '@nestjs/common';
import * as mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';

export type ExtractorKind = 'pdf' | 'docx' | 'text' | 'none';

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

  async extract(buffer: Buffer, mimeType: string, fileName: string): Promise<string> {
    const kind = selectExtractor(mimeType, fileName);
    try {
      switch (kind) {
        case 'pdf':
          return this.cap(await this.extractPdf(buffer));
        case 'docx': {
          const { value } = await mammoth.extractRawText({ buffer });
          return this.cap(value ?? '');
        }
        case 'text':
          return this.cap(buffer.toString('utf8'));
        default:
          return '';
      }
    } catch (err) {
      this.logger.warn(`Text extraction failed for "${fileName}" (${kind}): ${(err as Error).message}`);
      return '';
    }
  }

  private async extractPdf(buffer: Buffer): Promise<string> {
    const parser = new PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      return result.text ?? '';
    } finally {
      // Release the pdf.js worker so tests/process don't hang on open handles.
      await parser.destroy().catch(() => undefined);
    }
  }

  private cap(text: string): string {
    return text.length > MAX_EXTRACTED_TEXT_CHARS ? text.slice(0, MAX_EXTRACTED_TEXT_CHARS) : text;
  }
}
