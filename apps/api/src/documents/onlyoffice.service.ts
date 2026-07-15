import {
  BadRequestException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';
import { hostOf } from '../common/net.util';

/** OnlyOffice editor family, chosen by file extension. */
export type OnlyOfficeDocumentType = 'word' | 'cell' | 'slide';

/** Editable Office extensions → their OnlyOffice document type. */
const EDITABLE_TYPES: Record<string, OnlyOfficeDocumentType> = {
  docx: 'word',
  doc: 'word',
  odt: 'word',
  rtf: 'word',
  xlsx: 'cell',
  xls: 'cell',
  ods: 'cell',
  pptx: 'slide',
  ppt: 'slide',
  odp: 'slide',
};

/** Purpose bound into a scoped, signed URL token (prevents cross-use). */
type TokenPurpose = 'content' | 'callback';

interface ScopedTokenPayload {
  documentId: string;
  versionId: string;
  purpose: TokenPurpose;
  /** The editing user, carried on callback tokens so saves are attributed. */
  userId?: string;
}

/** Minimal shape of the payload OnlyOffice POSTs to the save callback. */
export interface OnlyOfficeCallbackBody {
  /** 1=editing, 2=ready-to-save, 3=save-error, 4=closed-no-change, 6=force-save, 7=force-save-error. */
  status: number;
  /** Download URL for the edited bytes (present on status 2 and 6). */
  url?: string;
  key?: string;
  /** Signed copy of the body when the Docs server has JWT enabled. */
  token?: string;
  [key: string]: unknown;
}

function extensionOf(fileName: string): string {
  const idx = (fileName ?? '').lastIndexOf('.');
  return idx >= 0 ? fileName.slice(idx + 1).toLowerCase() : '';
}

/** The OnlyOffice document type for a file, or null when it is not editable here. */
export function onlyOfficeDocumentType(fileName: string): OnlyOfficeDocumentType | null {
  return EDITABLE_TYPES[extensionOf(fileName)] ?? null;
}

/** Whether a file can be edited in OnlyOffice (docx/xlsx/pptx and friends). */
export function isOnlyOfficeEditable(fileName: string): boolean {
  return onlyOfficeDocumentType(fileName) !== null;
}

/** The file-type string OnlyOffice expects (the lowercase extension). */
export function editorFileType(fileName: string): string {
  return extensionOf(fileName);
}

/** Office/text mimetypes by extension, for naming an edited version's bytes. */
const MIME_BY_EXTENSION: Record<string, string> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  odt: 'application/vnd.oasis.opendocument.text',
  rtf: 'application/rtf',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odp: 'application/vnd.oasis.opendocument.presentation',
  txt: 'text/plain',
};

/**
 * Resolves the filename + mimetype to store an OnlyOffice-edited version under.
 *
 * On save, OnlyOffice returns a `filetype` in its callback (e.g. it edits a
 * legacy binary `.doc` but writes back modern `.docx` — it never round-trips
 * `.doc`). When that differs from the source's extension, we adopt the NEW
 * extension + mimetype so the stored bytes are labelled correctly. That also
 * makes a `.doc`→`.docx` upgrade text-extractable (search + version compare),
 * which the legacy `.doc` binary format is not. When the type is unchanged (or
 * unknown), we keep the source name/mime so the version's identity is stable.
 */
export function editedFileMeta(
  sourceFileName: string,
  callbackFileType: string | undefined,
  sourceMimeType: string,
): { fileName: string; mimeType: string } {
  const ext = (callbackFileType ?? '').toLowerCase().trim();
  const sourceExt = extensionOf(sourceFileName);
  // No change, or an extension we don't have a canonical mimetype for -> keep source.
  if (!ext || ext === sourceExt || !MIME_BY_EXTENSION[ext]) {
    return { fileName: sourceFileName, mimeType: sourceMimeType };
  }
  const stem =
    sourceFileName.lastIndexOf('.') >= 0
      ? sourceFileName.slice(0, sourceFileName.lastIndexOf('.'))
      : sourceFileName;
  return { fileName: `${stem}.${ext}`, mimeType: MIME_BY_EXTENSION[ext] };
}

/**
 * Whether a callback status means "persist the edited bytes as a new version".
 * 2 = document ready for saving (all editors closed); 6 = force-save while still
 * open. Every other status (editing/closed-no-change/error) creates no version.
 */
export function callbackWantsSave(status: number): boolean {
  return status === 2 || status === 6;
}

const CONTENT_TOKEN_TTL_SECONDS = 6 * 60 * 60; // editor fetches source right away
const CALLBACK_TOKEN_TTL_SECONDS = 24 * 60 * 60; // save can fire long after open

/**
 * OnlyOffice edit-in-browser integration (skill: onlyoffice-edit).
 *
 * Responsibilities:
 *  - sign the editor config (HS256, shared secret) so the Docs server trusts it;
 *  - mint short-lived, purpose-scoped tokens for the server-to-server content and
 *    callback URLs (no user JWT crosses to the Docs server);
 *  - verify the authenticity of save callbacks before any version is written.
 *
 * Networking (see AGENTS.md task notes): the Docs server (a container) reaches
 * this API via `ONLYOFFICE_API_INTERNAL_URL` (host.docker.internal on Docker
 * Desktop), NOT localhost. All URLs handed to OnlyOffice are built from it.
 */
@Injectable()
export class OnlyOfficeService {
  private readonly logger = new Logger(OnlyOfficeService.name);
  private readonly secret: string;
  private readonly apiInternalUrl: string;
  private readonly publicUrl: string;
  /**
   * Docs-server origin the API reaches server-side to fetch edited bytes on
   * save. In Docker the Docs server builds its callback download URL from its
   * OWN public address (`ONLYOFFICE_URL`, e.g. http://localhost:8080), which is
   * NOT reachable from inside the API container — `localhost` there is the API
   * itself. `ONLYOFFICE_INTERNAL_URL` is the Docker-network address (e.g.
   * http://onlyoffice) the API rewrites those callback URLs to. Defaults to
   * `ONLYOFFICE_URL` so a non-Docker/reverse-proxied deploy is unaffected.
   * Mirrors the S3_ENDPOINT vs S3_PUBLIC_ENDPOINT split.
   */
  private readonly internalUrl: string;
  /** Hosts the save callback may fetch edited bytes from (SM1 — SSRF allow-list). */
  private readonly downloadAllowedHosts: Set<string>;

  constructor(private readonly config: ConfigService) {
    // SH2: fail closed. A missing secret is a boot error — never a shipped
    // 'change-me' default that would let a forged editor config or save callback
    // through (JWT verification with a known default is no verification at all).
    this.secret = config.getOrThrow<string>('ONLYOFFICE_JWT_SECRET');
    this.apiInternalUrl = (
      config.get<string>('ONLYOFFICE_API_INTERNAL_URL') || 'http://host.docker.internal:3000'
    ).replace(/\/$/, '');
    this.publicUrl = (config.get<string>('ONLYOFFICE_URL') || 'http://localhost:8080').replace(
      /\/$/,
      '',
    );
    this.internalUrl = (config.get<string>('ONLYOFFICE_INTERNAL_URL') || this.publicUrl).replace(
      /\/$/,
      '',
    );
    this.downloadAllowedHosts = this.buildDownloadAllowlist();
  }

  /**
   * The set of hosts {@link downloadEditedFile} may fetch from (SM1). Always
   * includes the configured Docs-server host + the internal API host. When
   * `ONLYOFFICE_DOWNLOAD_ALLOWED_HOSTS` is set it is used verbatim (production
   * lock-down); otherwise loopback aliases are trusted so local/dev + tests work
   * out of the box while cloud-metadata / internal / arbitrary hosts stay blocked.
   */
  private buildDownloadAllowlist(): Set<string> {
    const hosts = new Set<string>();
    const add = (u?: string | null): void => {
      const h = u ? hostOf(u) : null;
      if (h) hosts.add(h);
    };
    add(this.publicUrl);
    add(this.internalUrl);
    add(this.apiInternalUrl);
    const override = this.config.get<string>('ONLYOFFICE_DOWNLOAD_ALLOWED_HOSTS');
    if (override && override.trim()) {
      override
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
        .forEach((h) => hosts.add(h));
    } else {
      ['localhost', '127.0.0.1', '::1', 'host.docker.internal'].forEach((h) => hosts.add(h));
    }
    return hosts;
  }

  /** Public Docs-server URL the browser loads `DocsAPI` from. */
  getPublicUrl(): string {
    return this.publicUrl;
  }

  /** Signs an arbitrary payload with the shared secret (HS256). */
  signToken(payload: object, ttlSeconds?: number): string {
    return jwt.sign(
      payload as object,
      this.secret,
      ttlSeconds ? { expiresIn: ttlSeconds } : {},
    );
  }

  /** Verifies + decodes a token signed with the shared secret. Throws on failure. */
  verifyToken<T = Record<string, unknown>>(token: string): T {
    return jwt.verify(token, this.secret) as T;
  }

  /**
   * Mints a scoped token for the server-to-server source-content URL. The editing
   * `userId` is carried so {@link DocumentsService.getVersionSource} can re-verify
   * access to (confidential) bytes as defence in depth (SH2).
   */
  signContentToken(documentId: string, versionId: string, userId?: string): string {
    return this.signToken(
      { documentId, versionId, purpose: 'content', userId } satisfies ScopedTokenPayload,
      CONTENT_TOKEN_TTL_SECONDS,
    );
  }

  /** Mints a scoped token for the save callback URL (attributed to the editor). */
  signCallbackToken(documentId: string, versionId: string, userId?: string): string {
    return this.signToken(
      { documentId, versionId, purpose: 'callback', userId } satisfies ScopedTokenPayload,
      CALLBACK_TOKEN_TTL_SECONDS,
    );
  }

  /**
   * Verifies a scoped URL token and asserts it matches the route it protects.
   * A valid signature is not enough — the embedded documentId/versionId/purpose
   * must match, so a content token can't be replayed as a callback token or
   * against a different document/version. Throws 401 on any mismatch. Returns the
   * verified payload (e.g. so a callback can attribute the save to `userId`).
   */
  verifyScopedToken(
    token: string,
    purpose: TokenPurpose,
    documentId: string,
    versionId: string,
  ): ScopedTokenPayload {
    let payload: ScopedTokenPayload;
    try {
      payload = this.verifyToken<ScopedTokenPayload>(token);
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
    if (
      payload.purpose !== purpose ||
      payload.documentId !== documentId ||
      payload.versionId !== versionId
    ) {
      throw new UnauthorizedException('Token does not authorize this resource');
    }
    return payload;
  }

  /**
   * Verifies a callback URL token whose route carries only the documentId (the
   * versionId lives inside the token). Checks signature + purpose + documentId,
   * then returns the trusted versionId and editing user. Throws 401 on mismatch.
   */
  verifyCallbackToken(
    token: string,
    documentId: string,
  ): { versionId: string; userId?: string } {
    let payload: ScopedTokenPayload;
    try {
      payload = this.verifyToken<ScopedTokenPayload>(token);
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
    if (payload.purpose !== 'callback' || payload.documentId !== documentId) {
      throw new UnauthorizedException('Token does not authorize this callback');
    }
    return { versionId: payload.versionId, userId: payload.userId };
  }

  /**
   * Verifies the authenticity of an OnlyOffice save callback. When the Docs
   * server has JWT enabled it signs the callback body and includes it as
   * `body.token` (or an `Authorization: Bearer` header). We require and verify
   * that signature so a forged callback cannot inject a version. Returns the
   * authenticated body (the inner signed payload takes precedence).
   */
  verifyCallbackBody(
    body: OnlyOfficeCallbackBody,
    authHeader?: string,
  ): OnlyOfficeCallbackBody {
    const bearer = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;
    const signed = body?.token ?? bearer;
    if (!signed) {
      throw new UnauthorizedException('Unsigned OnlyOffice callback rejected');
    }
    let decoded: { payload?: OnlyOfficeCallbackBody } & OnlyOfficeCallbackBody;
    try {
      decoded = this.verifyToken(signed);
    } catch {
      throw new UnauthorizedException('OnlyOffice callback signature invalid');
    }
    // Header-style tokens wrap the body under `payload`; body-style tokens are
    // the body itself. Prefer the verified inner payload as the source of truth.
    return (decoded.payload ?? decoded) as OnlyOfficeCallbackBody;
  }

  /**
   * Builds the signed editor config the browser hands to `DocsAPI.DocEditor`.
   * The whole config is signed (HS256) as `token` so the Docs server trusts it;
   * `document.key` is the immutable version id so the Docs cache is invalidated
   * whenever the underlying version changes.
   */
  buildEditorConfig(params: {
    documentId: string;
    versionId: string;
    fileName: string;
    documentType: OnlyOfficeDocumentType;
    user: { id: string; name: string };
  }): Record<string, unknown> {
    const { documentId, versionId, fileName } = params;
    const contentToken = this.signContentToken(documentId, versionId, params.user.id);
    const callbackToken = this.signCallbackToken(documentId, versionId, params.user.id);

    const document = {
      fileType: editorFileType(fileName),
      key: versionId,
      title: fileName,
      url: `${this.apiInternalUrl}/api/documents/${documentId}/versions/${versionId}/content?token=${contentToken}`,
      permissions: { edit: true, download: true },
    };
    const editorConfig = {
      callbackUrl: `${this.apiInternalUrl}/api/documents/${documentId}/editor-callback?token=${callbackToken}`,
      user: { id: params.user.id, name: params.user.name },
      mode: 'edit',
      lang: 'en',
    };
    const config: Record<string, unknown> = {
      document,
      documentType: params.documentType,
      editorConfig,
    };
    // The Docs server validates this signature over the config it receives.
    config.token = this.signToken(config);
    return config;
  }

  /**
   * Downloads the edited bytes the Docs server produced on save (from the `url`
   * in the callback body). Throws on a non-OK response so the caller can decline
   * to create a bogus version.
   *
   * ⚠️ Networking: `body.url` is built by the Docs server from its OWN public
   * address (`ONLYOFFICE_URL`, e.g. http://localhost:8080), which the API can't
   * reach from inside its container. We rewrite the URL's origin to
   * `ONLYOFFICE_INTERNAL_URL` (the Docker-network address) before fetching. The
   * SSRF check runs on the ORIGINAL callback host (must be allow-listed); the
   * rewrite only swaps a trusted public origin for its trusted internal twin.
   */
  async downloadEditedFile(url: string): Promise<Buffer> {
    this.assertDownloadUrlAllowed(url);
    const fetchUrl = this.toInternalDownloadUrl(url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    try {
      const res = await fetch(fetchUrl, { signal: controller.signal, redirect: 'error' });
      if (!res.ok) {
        throw new Error(`OnlyOffice edited-file download failed: HTTP ${res.status}`);
      }
      return Buffer.from(await res.arrayBuffer());
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Rewrites a callback download URL whose origin is the Docs server's PUBLIC
   * address (`publicUrl`) to the API-reachable INTERNAL address (`internalUrl`),
   * preserving the path + query (the signed md5/expires token). A no-op when the
   * two are equal (non-Docker deploy) or the URL is on some other allow-listed
   * host (e.g. host.docker.internal). Same-origin swap only — never changes the
   * path — so the Docs server's signature over path+query still validates.
   */
  private toInternalDownloadUrl(url: string): string {
    if (this.internalUrl === this.publicUrl) return url;
    let pub: URL;
    let target: URL;
    try {
      pub = new URL(this.publicUrl);
      target = new URL(this.internalUrl);
    } catch {
      return url;
    }
    const u = new URL(url);
    // Only rewrite when the callback host matches the public Docs-server host.
    if (u.host !== pub.host) return url;
    u.protocol = target.protocol;
    u.hostname = target.hostname;
    // Set the port explicitly (empty when the target has none, e.g. :80/:443
    // implied) — assigning hostname alone leaves the old port in place.
    u.port = target.port;
    return u.toString();
  }

  /**
   * SSRF guard (SM1): the Docs server hands us `body.url` to fetch the edited bytes.
   * A forged/compromised callback could point that at cloud metadata (169.254.169.254),
   * an internal service, or an arbitrary host to exfiltrate/pivot. We fetch ONLY from
   * an http(s) URL whose host is on the allow-list, and disable redirects.
   */
  private assertDownloadUrlAllowed(url: string): void {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new BadRequestException('OnlyOffice save callback URL is invalid');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new BadRequestException('OnlyOffice save callback URL scheme is not allowed');
    }
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (this.downloadAllowedHosts.has(host)) return;
    this.logger.warn(
      `Rejected OnlyOffice save-callback download to non-allow-listed host "${host}"`,
    );
    throw new BadRequestException('OnlyOffice save callback URL host is not allowed');
  }
}
