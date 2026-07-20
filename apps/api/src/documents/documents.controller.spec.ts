import { ALLOWED_UPLOAD_EXTENSIONS, extensionOf } from './documents.controller';

/**
 * FINDING-001: unit-level coverage of the upload file-type allowlist logic
 * (the e2e "rejects a disallowed file extension" test exercises the full
 * FileInterceptor wiring against a live server; these are fast, DB-free
 * checks of the extension-derivation and allowlist membership themselves).
 */
describe('documents.controller upload allowlist (FINDING-001)', () => {
  describe('extensionOf', () => {
    it('lowercases and strips the leading dot', () => {
      expect(extensionOf('Policy.PDF')).toBe('pdf');
      expect(extensionOf('report.DOCX')).toBe('docx');
    });

    it('returns an empty string for a file with no extension', () => {
      expect(extensionOf('README')).toBe('');
    });

    it('uses the LAST dot for a multi-dot filename', () => {
      expect(extensionOf('archive.tar.gz')).toBe('gz');
    });
  });

  describe('ALLOWED_UPLOAD_EXTENSIONS', () => {
    it('includes every AGENTS.md §10a supported document type', () => {
      for (const ext of ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md']) {
        expect(ALLOWED_UPLOAD_EXTENSIONS.has(ext)).toBe(true);
      }
    });

    it('includes common image formats', () => {
      for (const ext of ['png', 'jpg', 'jpeg', 'gif', 'webp']) {
        expect(ALLOWED_UPLOAD_EXTENSIONS.has(ext)).toBe(true);
      }
    });

    it('excludes executable/script extensions', () => {
      for (const ext of ['exe', 'sh', 'bat', 'js', 'html', 'svg', 'php']) {
        expect(ALLOWED_UPLOAD_EXTENSIONS.has(ext)).toBe(false);
      }
    });
  });
});
