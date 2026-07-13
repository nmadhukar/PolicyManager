import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3Service } from '../storage/s3.service';

/**
 * Which pipeline (if any) produces a uniform PDF rendition for a source file.
 *  - `passthrough` — already a PDF; the source itself is viewable, no rendition.
 *  - `image`       — rendered natively in the browser; no PDF rendition.
 *  - `html`        — app-authored HTML → PDF via Gotenberg Chromium route.
 *  - `office`      — Office/text formats → PDF via Gotenberg LibreOffice route.
 *  - `none`        — unsupported for rendition; original download only.
 */
export type RenditionStrategy = 'passthrough' | 'image' | 'html' | 'office' | 'none';

const PDF_MIME = 'application/pdf';
const HTML_MIMES = new Set(['text/html', 'application/xhtml+xml']);

/**
 * Office/text formats LibreOffice can render to PDF. Extensions are the fallback
 * because browsers/importers frequently send `application/octet-stream`.
 */
const OFFICE_EXTENSIONS = new Set([
  'doc',
  'docx',
  'odt',
  'rtf',
  'txt',
  'md',
  'markdown',
  'csv',
  'xls',
  'xlsx',
  'ods',
  'ppt',
  'pptx',
  'odp',
]);

const OFFICE_MIMES = new Set([
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.oasis.opendocument.text',
  'application/rtf',
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.oasis.opendocument.presentation',
]);

function extensionOf(fileName: string): string {
  const idx = (fileName ?? '').lastIndexOf('.');
  return idx >= 0 ? fileName.slice(idx + 1).toLowerCase() : '';
}

/**
 * Pure dispatch: decides how (or whether) to build a PDF rendition from the
 * source mime type and/or file name. Order matters — PDF and images short-circuit
 * before the Office/text check so a `.pdf` never routes through LibreOffice.
 *
 * Contract (AGENTS.md §10a): the source bytes are NEVER mutated by conversion;
 * the rendition is a separate derived object.
 */
export function renditionStrategyFor(mimeType: string, fileName: string): RenditionStrategy {
  const mime = (mimeType || '').toLowerCase().split(';')[0].trim();
  const ext = extensionOf(fileName || '');

  if (mime === PDF_MIME || ext === 'pdf') return 'passthrough';
  if (mime.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(ext)) {
    return 'image';
  }
  if (HTML_MIMES.has(mime) || ['html', 'htm'].includes(ext)) return 'html';
  if (OFFICE_MIMES.has(mime) || OFFICE_EXTENSIONS.has(ext)) return 'office';
  return 'none';
}

/** True when a source of this type yields a PDF rendition that must be generated. */
export function requiresRendition(mimeType: string, fileName: string): boolean {
  const strategy = renditionStrategyFor(mimeType, fileName);
  return strategy === 'office' || strategy === 'html';
}

/** Result of a rendition attempt handed back to the caller. */
export interface RenditionResult {
  /** The stored rendition object key, or null when none was produced. */
  renditionS3Key: string | null;
  strategy: RenditionStrategy;
}

/**
 * Generates and stores uniform PDF renditions via a self-hosted Gotenberg
 * instance so any supported document can be viewed in-browser without mutating
 * the immutable source version (AGENTS.md §10a; skill: document-rendition-viewer).
 *
 * Failure policy: rendition generation is BEST-EFFORT. Any conversion/storage
 * failure is logged and yields `renditionS3Key: null` — it must never fail the
 * upload/version write that triggered it.
 */
@Injectable()
export class RenditionService {
  private readonly logger = new Logger(RenditionService.name);
  private readonly gotenbergUrl: string;
  private readonly timeoutMs: number;

  constructor(
    private readonly config: ConfigService,
    private readonly s3: S3Service,
  ) {
    this.gotenbergUrl = (config.get<string>('GOTENBERG_URL') || 'http://localhost:3001').replace(
      /\/$/,
      '',
    );
    this.timeoutMs = Number(config.get('GOTENBERG_TIMEOUT_MS')) || 60_000;
  }

  /**
   * Best-effort: builds a PDF rendition for a freshly written version and stores
   * it at the deterministic rendition key. Returns the key (and chosen strategy),
   * or null when no rendition applies or conversion failed.
   *
   * `sourceBuffer` is optional; when omitted (e.g. on-demand regeneration) the
   * source bytes are pulled from S3 by the provided key.
   */
  async generateForVersion(params: {
    documentId: string;
    versionNumber: number;
    mimeType: string;
    fileName: string;
    sourceS3Key: string;
    sourceBuffer?: Buffer;
  }): Promise<RenditionResult> {
    const strategy = renditionStrategyFor(params.mimeType, params.fileName);
    if (strategy !== 'office' && strategy !== 'html') {
      // PDF/image/none: nothing to generate — the viewer uses the source directly.
      return { renditionS3Key: null, strategy };
    }

    try {
      const source =
        params.sourceBuffer ?? (await this.s3.getObjectBuffer(params.sourceS3Key));
      const pdf =
        strategy === 'html'
          ? await this.convertHtmlToPdf(source.toString('utf8'))
          : await this.convertOfficeToPdf(source, params.fileName);

      const key = this.s3.buildRenditionKey(params.documentId, params.versionNumber);
      await this.s3.putObject(key, pdf, PDF_MIME);
      return { renditionS3Key: key, strategy };
    } catch (err) {
      this.logger.warn(
        `Rendition generation failed for document ${params.documentId} v${params.versionNumber} ` +
          `(${strategy}): ${(err as Error).message}. Original remains downloadable.`,
      );
      return { renditionS3Key: null, strategy };
    }
  }

  /** Converts an Office/text file buffer to PDF via Gotenberg's LibreOffice route. */
  async convertOfficeToPdf(buffer: Buffer, fileName: string): Promise<Buffer> {
    const form = new FormData();
    // Gotenberg detects the source format from the uploaded file's extension, so
    // the filename (incl. extension) must be preserved on the `files` part.
    // Copy into a fresh Uint8Array so the Blob part has a plain ArrayBuffer.
    form.append('files', new Blob([new Uint8Array(buffer)]), safeGotenbergName(fileName));
    return this.postForPdf('/forms/libreoffice/convert', form);
  }

  /** Converts an HTML string to PDF via Gotenberg's Chromium route. */
  async convertHtmlToPdf(html: string): Promise<Buffer> {
    const form = new FormData();
    // Chromium's HTML route requires the main file to be named exactly index.html.
    form.append('files', new Blob([html], { type: 'text/html' }), 'index.html');
    return this.postForPdf('/forms/chromium/convert/html', form);
  }

  /** POSTs a multipart form to Gotenberg and returns the PDF bytes (or throws). */
  private async postForPdf(path: string, form: FormData): Promise<Buffer> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.gotenbergUrl}${path}`, {
        method: 'POST',
        body: form,
        signal: controller.signal,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`Gotenberg ${res.status} at ${path}: ${detail.slice(0, 200)}`);
      }
      return Buffer.from(await res.arrayBuffer());
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Keeps the extension (so Gotenberg detects the format) while stripping paths. */
function safeGotenbergName(fileName: string): string {
  const base = (fileName ?? '').split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+/, '');
  return cleaned.length > 0 ? cleaned : 'document';
}
