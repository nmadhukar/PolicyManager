import { buildDocumentObjectKey, sanitizeFileName } from './s3-key.util';

describe('sanitizeFileName', () => {
  it('strips directory components and keeps the base name', () => {
    expect(sanitizeFileName('/etc/passwd')).toBe('passwd');
    expect(sanitizeFileName('C:\\docs\\Policy V2.pdf')).toBe('Policy_V2.pdf');
  });

  it('replaces unsafe characters with underscores', () => {
    expect(sanitizeFileName('a b*c?.txt')).toBe('a_b_c_.txt');
  });

  it('falls back to a safe default for empty/garbage names', () => {
    expect(sanitizeFileName('')).toBe('file');
    expect(sanitizeFileName('///')).toBe('file');
    expect(sanitizeFileName('***')).toBe('file');
  });

  it('collapses path traversal attempts to a plain name', () => {
    // Only the base segment survives, so "../../secret" cannot escape the prefix.
    expect(sanitizeFileName('../../secret.pdf')).toBe('secret.pdf');
  });
});

describe('buildDocumentObjectKey', () => {
  it('produces the deterministic {prefix}{docId}/v{n}/{file} key', () => {
    expect(buildDocumentObjectKey('documents/', 'doc-1', 3, 'Report.pdf')).toBe(
      'documents/doc-1/v3/Report.pdf',
    );
  });

  it('normalizes a prefix missing its trailing slash', () => {
    expect(buildDocumentObjectKey('documents', 'doc-1', 1, 'a.pdf')).toBe(
      'documents/doc-1/v1/a.pdf',
    );
  });

  it('is stable/deterministic for the same inputs', () => {
    const a = buildDocumentObjectKey('documents/', 'doc-9', 2, 'x.docx');
    const b = buildDocumentObjectKey('documents/', 'doc-9', 2, 'x.docx');
    expect(a).toBe(b);
  });

  it('sanitizes the file name inside the key so no path traversal is possible', () => {
    expect(buildDocumentObjectKey('documents/', 'doc-1', 1, '../../evil.pdf')).toBe(
      'documents/doc-1/v1/evil.pdf',
    );
  });
});
