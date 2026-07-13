import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface OcrResult {
  text: string;
}

interface OcrSkip {
  skipped: true;
  reason: string;
}

/** Parses a string/boolean env flag into a real boolean. */
function envBool(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.toLowerCase() === 'true';
  return fallback;
}

/**
 * Thin HTTP adapter for a self-hosted OCR service.
 *
 * The app never sends document bytes to a vendor service here. Operators must
 * explicitly enable OCR and point OCR_ENDPOINT at their own OCRmyPDF/Tesseract
 * gateway; when it is absent, scanned PDFs/images are marked skipped instead of
 * blocking uploads or leaking bytes.
 */
@Injectable()
export class OcrService {
  private readonly logger = new Logger(OcrService.name);
  private readonly enabled: boolean;
  private readonly endpoint: string | null;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly maxPages: number;
  private readonly pdfMinTextChars: number;

  constructor(config: ConfigService) {
    this.enabled = envBool(config.get('OCR_ENABLED'), false);
    this.endpoint = (config.get<string>('OCR_ENDPOINT') || '').replace(/\/+$/, '') || null;
    this.timeoutMs = Number(config.get('OCR_TIMEOUT_MS') ?? 120_000);
    this.maxBytes = Number(config.get('OCR_MAX_BYTES') ?? 25 * 1024 * 1024);
    this.maxPages = Number(config.get('OCR_MAX_PAGES') ?? 50);
    this.pdfMinTextChars = Number(config.get('OCR_PDF_MIN_TEXT_CHARS') ?? 24);
  }

  isConfigured(): boolean {
    return this.enabled && !!this.endpoint;
  }

  shouldOcrPdfText(text: string): boolean {
    return text.trim().length < this.pdfMinTextChars;
  }

  skipReasonFor(buffer: Buffer, pages?: number | null): OcrSkip | null {
    if (!this.isConfigured()) {
      return { skipped: true, reason: 'OCR is disabled or OCR_ENDPOINT is not configured.' };
    }
    if (buffer.length > this.maxBytes) {
      return { skipped: true, reason: `OCR skipped because file exceeds ${this.maxBytes} bytes.` };
    }
    if (pages && pages > this.maxPages) {
      return { skipped: true, reason: `OCR skipped because PDF has ${pages} pages.` };
    }
    return null;
  }

  async extract(buffer: Buffer, mimeType: string, fileName: string): Promise<OcrResult> {
    const skip = this.skipReasonFor(buffer);
    if (skip) throw new Error(skip.reason);

    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(buffer)], { type: mimeType }), fileName);
    form.append('mimeType', mimeType);

    const response = await fetch(`${this.endpoint}/ocr`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`OCR service returned ${response.status}`);
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      const payload = (await response.json()) as { text?: unknown };
      return { text: typeof payload.text === 'string' ? payload.text : '' };
    }
    return { text: await response.text() };
  }

  logFailure(fileName: string, err: unknown): void {
    this.logger.warn(`OCR failed for "${fileName}": ${(err as Error).message}`);
  }
}
