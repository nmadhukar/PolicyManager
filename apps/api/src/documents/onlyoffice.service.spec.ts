import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';
import {
  OnlyOfficeService,
  callbackWantsSave,
  editedFileMeta,
  editorFileType,
  isOnlyOfficeEditable,
  onlyOfficeDocumentType,
} from './onlyoffice.service';

describe('OnlyOffice pure helpers', () => {
  it('maps extensions to the correct document type', () => {
    expect(onlyOfficeDocumentType('a.docx')).toBe('word');
    expect(onlyOfficeDocumentType('a.DOCX')).toBe('word');
    expect(onlyOfficeDocumentType('b.xlsx')).toBe('cell');
    expect(onlyOfficeDocumentType('c.pptx')).toBe('slide');
    expect(onlyOfficeDocumentType('d.pdf')).toBeNull();
    expect(onlyOfficeDocumentType('e.png')).toBeNull();
  });

  it('reports editability + file type', () => {
    expect(isOnlyOfficeEditable('x.docx')).toBe(true);
    expect(isOnlyOfficeEditable('x.pdf')).toBe(false);
    expect(editorFileType('Policy.DOCX')).toBe('docx');
  });

  it('only persists a version on save statuses 2 and 6', () => {
    expect(callbackWantsSave(2)).toBe(true); // ready to save
    expect(callbackWantsSave(6)).toBe(true); // force-save
    expect(callbackWantsSave(1)).toBe(false); // editing
    expect(callbackWantsSave(4)).toBe(false); // closed, no changes
    expect(callbackWantsSave(3)).toBe(false); // save error
  });

  describe('editedFileMeta', () => {
    const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

    it('upgrades a legacy .doc to .docx when OnlyOffice returns filetype=docx', () => {
      expect(editedFileMeta('sample.doc', 'docx', 'application/msword')).toEqual({
        fileName: 'sample.docx',
        mimeType: DOCX_MIME,
      });
    });

    it('keeps the source name/mime when the filetype is unchanged', () => {
      expect(editedFileMeta('policy.docx', 'docx', DOCX_MIME)).toEqual({
        fileName: 'policy.docx',
        mimeType: DOCX_MIME,
      });
    });

    it('keeps the source when filetype is missing (older Docs servers)', () => {
      expect(editedFileMeta('sample.doc', undefined, 'application/msword')).toEqual({
        fileName: 'sample.doc',
        mimeType: 'application/msword',
      });
    });

    it('keeps the source when the returned filetype has no canonical mimetype', () => {
      expect(editedFileMeta('sample.doc', 'weird', 'application/msword')).toEqual({
        fileName: 'sample.doc',
        mimeType: 'application/msword',
      });
    });

    it('handles a source name with no extension', () => {
      expect(editedFileMeta('untitled', 'docx', 'application/octet-stream')).toEqual({
        fileName: 'untitled.docx',
        mimeType: DOCX_MIME,
      });
    });
  });
});

const SECRET = 'unit-secret';
const build = () =>
  new OnlyOfficeService(
    new ConfigService({
      ONLYOFFICE_JWT_SECRET: SECRET,
      ONLYOFFICE_API_INTERNAL_URL: 'http://host.docker.internal:3000',
      ONLYOFFICE_URL: 'http://localhost:8080',
    }),
  );

describe('OnlyOfficeService token signing', () => {
  it('signs + verifies a round-trip payload', () => {
    const svc = build();
    const token = svc.signToken({ hello: 'world' });
    expect(svc.verifyToken<{ hello: string }>(token).hello).toBe('world');
  });

  it('rejects a token signed with a different secret', () => {
    const svc = build();
    const forged = jwt.sign({ a: 1 }, 'wrong-secret');
    expect(() => svc.verifyToken(forged)).toThrow();
  });

  it('scoped tokens are bound to purpose + document + version', () => {
    const svc = build();
    const token = svc.signContentToken('doc-1', 'v-1');
    // Correct scope passes.
    expect(() => svc.verifyScopedToken(token, 'content', 'doc-1', 'v-1')).not.toThrow();
    // Wrong purpose (content token replayed as callback) is rejected.
    expect(() => svc.verifyScopedToken(token, 'callback', 'doc-1', 'v-1')).toThrow(
      UnauthorizedException,
    );
    // Wrong document/version is rejected.
    expect(() => svc.verifyScopedToken(token, 'content', 'doc-2', 'v-1')).toThrow(
      UnauthorizedException,
    );
    expect(() => svc.verifyScopedToken(token, 'content', 'doc-1', 'v-2')).toThrow(
      UnauthorizedException,
    );
  });

  it('rejects a tampered/garbage scoped token with 401', () => {
    const svc = build();
    expect(() => svc.verifyScopedToken('not-a-jwt', 'content', 'doc-1', 'v-1')).toThrow(
      UnauthorizedException,
    );
  });

  it('verifyCallbackToken returns the trusted versionId + editor from a callback token', () => {
    const svc = build();
    const token = svc.signCallbackToken('doc-1', 'v-7', 'u-42');
    expect(svc.verifyCallbackToken(token, 'doc-1')).toEqual({ versionId: 'v-7', userId: 'u-42' });
    // Wrong document is rejected.
    expect(() => svc.verifyCallbackToken(token, 'doc-2')).toThrow(UnauthorizedException);
    // A content token cannot be used as a callback token.
    const contentToken = svc.signContentToken('doc-1', 'v-7');
    expect(() => svc.verifyCallbackToken(contentToken, 'doc-1')).toThrow(UnauthorizedException);
  });
});

describe('OnlyOfficeService.buildEditorConfig', () => {
  it('produces a signed config with internal URLs, per-version key, and document type', () => {
    const svc = build();
    const config = svc.buildEditorConfig({
      documentId: 'doc-1',
      versionId: 'v-42',
      fileName: 'policy.docx',
      documentType: 'word',
      user: { id: 'u-1', name: 'Dr Smith' },
    });

    const document = config.document as Record<string, unknown>;
    const editorConfig = config.editorConfig as Record<string, unknown>;

    expect(config.documentType).toBe('word');
    expect(document.fileType).toBe('docx');
    // Per-version key so the Docs cache invalidates when the version changes.
    expect(document.key).toBe('v-42');
    expect(document.title).toBe('policy.docx');
    // URLs are built from the container-reachable internal URL, not localhost.
    expect(document.url).toContain('http://host.docker.internal:3000/api/documents/doc-1/');
    expect(document.url).toContain('/versions/v-42/content?token=');
    expect(editorConfig.callbackUrl).toContain(
      'http://host.docker.internal:3000/api/documents/doc-1/editor-callback?token=',
    );
    expect(editorConfig.user).toEqual({ id: 'u-1', name: 'Dr Smith' });
  });

  it('signs the config so the Docs server can verify it (token verifies back)', () => {
    const svc = build();
    const config = svc.buildEditorConfig({
      documentId: 'doc-1',
      versionId: 'v-42',
      fileName: 'sheet.xlsx',
      documentType: 'cell',
      user: { id: 'u-1', name: 'A' },
    });
    const token = config.token as string;
    expect(typeof token).toBe('string');
    const decoded = svc.verifyToken<{ documentType: string }>(token);
    expect(decoded.documentType).toBe('cell');
  });

  it('embeds content + callback tokens that verify with the right scope', () => {
    const svc = build();
    const config = svc.buildEditorConfig({
      documentId: 'doc-1',
      versionId: 'v-9',
      fileName: 'a.docx',
      documentType: 'word',
      user: { id: 'u', name: 'n' },
    });
    const contentUrl = (config.document as { url: string }).url;
    const callbackUrl = (config.editorConfig as { callbackUrl: string }).callbackUrl;
    const contentToken = new URL(contentUrl).searchParams.get('token') as string;
    const callbackToken = new URL(callbackUrl).searchParams.get('token') as string;

    expect(() => svc.verifyScopedToken(contentToken, 'content', 'doc-1', 'v-9')).not.toThrow();
    expect(() => svc.verifyScopedToken(callbackToken, 'callback', 'doc-1', 'v-9')).not.toThrow();
  });
});

describe('OnlyOfficeService.verifyCallbackBody', () => {
  it('accepts a body carrying a valid signed token and returns the inner payload', () => {
    const svc = build();
    const inner = { status: 2, url: 'http://docs/cache/out.docx', key: 'v-1' };
    const token = jwt.sign(inner, SECRET);
    const authenticated = svc.verifyCallbackBody({ ...inner, token });
    expect(authenticated.status).toBe(2);
    expect(authenticated.url).toBe('http://docs/cache/out.docx');
  });

  it('accepts a Bearer header token wrapping the body under payload', () => {
    const svc = build();
    const inner = { status: 6, url: 'http://docs/cache/out.docx' };
    const token = jwt.sign({ payload: inner }, SECRET);
    const authenticated = svc.verifyCallbackBody({ status: 6 }, `Bearer ${token}`);
    expect(authenticated.url).toBe('http://docs/cache/out.docx');
  });

  it('rejects an unsigned callback (no token anywhere)', () => {
    const svc = build();
    expect(() => svc.verifyCallbackBody({ status: 2, url: 'x' })).toThrow(UnauthorizedException);
  });

  it('rejects a callback signed with the wrong secret', () => {
    const svc = build();
    const token = jwt.sign({ status: 2 }, 'attacker-secret');
    expect(() => svc.verifyCallbackBody({ status: 2, token })).toThrow(UnauthorizedException);
  });
});

describe('OnlyOfficeService.downloadEditedFile SSRF guard (SM1)', () => {
  it('rejects a URL whose host is not on the allow-list (before any fetch)', async () => {
    const svc = build();
    // Cloud metadata, internal RFC-1918, and arbitrary public hosts are all denied
    // (default allow-list = Docs host + loopback only).
    await expect(svc.downloadEditedFile('http://169.254.169.254/latest/meta-data')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(svc.downloadEditedFile('http://10.1.2.3/secret')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(svc.downloadEditedFile('http://evil.example.com/x')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejects a non-http(s) scheme', async () => {
    const svc = build();
    await expect(svc.downloadEditedFile('file:///etc/passwd')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('honours ONLYOFFICE_DOWNLOAD_ALLOWED_HOSTS for the Docs host', async () => {
    const svc = new OnlyOfficeService(
      new ConfigService({
        ONLYOFFICE_JWT_SECRET: SECRET,
        ONLYOFFICE_URL: 'http://localhost:8080',
        ONLYOFFICE_DOWNLOAD_ALLOWED_HOSTS: 'docs.internal',
      }),
    );
    // With an explicit allow-list, the broad loopback aliases (e.g. 127.0.0.1) are
    // no longer auto-trusted — only the Docs host + configured hosts pass.
    await expect(svc.downloadEditedFile('http://127.0.0.1:9999/x')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    // ...but a non-allow-listed host is still rejected before fetching.
    await expect(svc.downloadEditedFile('http://other.host/x')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

describe('OnlyOfficeService.downloadEditedFile Docker-network URL rewrite', () => {
  const realFetch = global.fetch;
  // @nestjs/config's ConfigService gives process.env PRECEDENCE over the
  // constructor object, so these tests must control the env var directly
  // (it is set in the API container, which would otherwise leak in).
  const savedInternalUrl = process.env.ONLYOFFICE_INTERNAL_URL;
  const savedUrl = process.env.ONLYOFFICE_URL;
  afterEach(() => {
    global.fetch = realFetch;
    if (savedInternalUrl === undefined) delete process.env.ONLYOFFICE_INTERNAL_URL;
    else process.env.ONLYOFFICE_INTERNAL_URL = savedInternalUrl;
    if (savedUrl === undefined) delete process.env.ONLYOFFICE_URL;
    else process.env.ONLYOFFICE_URL = savedUrl;
  });

  it('rewrites the callback URL origin from the public Docs host to ONLYOFFICE_INTERNAL_URL, keeping path+query', async () => {
    process.env.ONLYOFFICE_URL = 'http://localhost:8080';
    process.env.ONLYOFFICE_INTERNAL_URL = 'http://onlyoffice';
    const svc = new OnlyOfficeService(
      new ConfigService({
        ONLYOFFICE_JWT_SECRET: SECRET,
        ONLYOFFICE_URL: 'http://localhost:8080', // browser-facing, what the callback URL uses
        ONLYOFFICE_INTERNAL_URL: 'http://onlyoffice', // API-reachable Docker host (port 80)
      }),
    );
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    });
    global.fetch = fetchMock as never;

    // The callback URL the Docs server produces (host = localhost:8080).
    const callbackUrl = 'http://localhost:8080/cache/files/data/abc/output.docx?md5=xyz&expires=123';
    const buf = await svc.downloadEditedFile(callbackUrl);

    expect(buf).toEqual(Buffer.from([1, 2, 3]));
    // Fetched from the INTERNAL host, with the signed path + query preserved.
    const fetchedUrl = fetchMock.mock.calls[0][0] as string;
    expect(fetchedUrl).toBe('http://onlyoffice/cache/files/data/abc/output.docx?md5=xyz&expires=123');
  });

  it('does NOT rewrite when ONLYOFFICE_INTERNAL_URL is unset (equals public) — non-Docker deploy', async () => {
    process.env.ONLYOFFICE_URL = 'http://localhost:8080';
    delete process.env.ONLYOFFICE_INTERNAL_URL;
    const svc = new OnlyOfficeService(
      new ConfigService({ ONLYOFFICE_JWT_SECRET: SECRET, ONLYOFFICE_URL: 'http://localhost:8080' }),
    );
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new Uint8Array([9]).buffer,
    });
    global.fetch = fetchMock as never;

    const callbackUrl = 'http://localhost:8080/cache/files/x/output.docx?md5=q';
    await svc.downloadEditedFile(callbackUrl);
    expect(fetchMock.mock.calls[0][0]).toBe(callbackUrl); // unchanged
  });
});
