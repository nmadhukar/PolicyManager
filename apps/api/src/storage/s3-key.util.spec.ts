import {
  buildDocumentObjectKey,
  buildRenditionObjectKey,
  normalizeFolderPrefix,
  sanitizeFileName,
  validateBucketName,
} from './s3-key.util';

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

describe('buildRenditionObjectKey', () => {
  it('produces a deterministic, version-scoped rendition key under the prefix', () => {
    expect(buildRenditionObjectKey('renditions/', 'doc-1', 3)).toBe(
      'renditions/doc-1/v3/rendition.pdf',
    );
  });

  it('normalizes a prefix missing its trailing slash', () => {
    expect(buildRenditionObjectKey('renditions', 'doc-1', 1)).toBe(
      'renditions/doc-1/v1/rendition.pdf',
    );
  });

  it('is disjoint from the source document key (never overwrites source bytes)', () => {
    const source = buildDocumentObjectKey('documents/', 'doc-1', 1, 'policy.docx');
    const rendition = buildRenditionObjectKey('renditions/', 'doc-1', 1);
    expect(rendition).not.toBe(source);
  });
});

describe('validateBucketName', () => {
  it('accepts a valid DNS-style bucket name', () => {
    expect(validateBucketName('policymanager-docs')).toBeNull();
    expect(validateBucketName('abc')).toBeNull();
  });

  it('rejects names that are too short or too long', () => {
    expect(validateBucketName('ab')).toMatch(/3 and 63/);
    expect(validateBucketName('a'.repeat(64))).toMatch(/3 and 63/);
  });

  it('rejects uppercase, spaces, and illegal characters', () => {
    expect(validateBucketName('MyBucket')).toMatch(/lowercase/);
    expect(validateBucketName('my bucket')).toMatch(/lowercase/);
    expect(validateBucketName('-leading')).toMatch(/lowercase/);
    expect(validateBucketName('trailing-')).toMatch(/lowercase/);
  });

  it('rejects consecutive hyphens and IP-formatted names', () => {
    expect(validateBucketName('a--b')).toMatch(/consecutive/);
    expect(validateBucketName('192.168.0.1')).toMatch(/IP address/);
  });
});

describe('normalizeFolderPrefix', () => {
  it('produces a trailing-slash marker key from nested segments', () => {
    expect(normalizeFolderPrefix('policies/intake')).toBe('policies/intake/');
  });

  it('strips leading slashes, traversal, and redundant separators', () => {
    expect(normalizeFolderPrefix('/a//b/')).toBe('a/b/');
    expect(normalizeFolderPrefix('../../etc')).toBe('etc/');
  });

  it('replaces unsafe characters within a segment', () => {
    expect(normalizeFolderPrefix('my folder!')).toBe('my_folder/');
  });

  it('returns null when nothing safe remains', () => {
    expect(normalizeFolderPrefix('')).toBeNull();
    expect(normalizeFolderPrefix('///')).toBeNull();
    expect(normalizeFolderPrefix('..')).toBeNull();
  });
});
