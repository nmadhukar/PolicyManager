import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';

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

  constructor(private readonly config: ConfigService) {
    this.secret = config.get<string>('ONLYOFFICE_JWT_SECRET') || 'change-me-onlyoffice';
    this.apiInternalUrl = (
      config.get<string>('ONLYOFFICE_API_INTERNAL_URL') || 'http://host.docker.internal:3000'
    ).replace(/\/$/, '');
    this.publicUrl = (config.get<string>('ONLYOFFICE_URL') || 'http://localhost:8080').replace(
      /\/$/,
      '',
    );
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

  /** Mints a scoped token for the server-to-server source-content URL. */
  signContentToken(documentId: string, versionId: string): string {
    return this.signToken(
      { documentId, versionId, purpose: 'content' } satisfies ScopedTokenPayload,
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
    const contentToken = this.signContentToken(documentId, versionId);
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
   * ⚠️ Networking caveat: `body.url` is built by the Docs server using its own
   * view of the network. In a container setup that host may not equal the URL a
   * browser sees. In production, ensure the API can reach the Docs server on the
   * origin the callback uses (or front both behind a shared hostname).
   */
  async downloadEditedFile(url: string): Promise<Buffer> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) {
        throw new Error(`OnlyOffice edited-file download failed: HTTP ${res.status}`);
      }
      return Buffer.from(await res.arrayBuffer());
    } finally {
      clearTimeout(timer);
    }
  }
}
