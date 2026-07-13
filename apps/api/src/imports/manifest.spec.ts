import {
  MAX_MANIFEST_ROWS,
  parseManifest,
  parseTags,
  splitCategoryPath,
  titleFromFileName,
} from './manifest';

const buf = (s: string): Buffer => Buffer.from(s, 'utf8');

/**
 * Unit tests for the pure CSV-manifest parser (AGENTS.md §6 — TDD for logic):
 * header detection, the required-title rule, per-row validation isolation, tag &
 * category-path parsing, and the whole-file guardrails.
 */
describe('parseManifest', () => {
  it('parses a well-formed manifest into normalized rows and detects the columns', () => {
    const csv =
      'fileName,title,category,documentNumber,owner,tags,accessLevel,reviewCadence,description\n' +
      'a.pdf,Policy A,Policies/Clinical,PP-1,jane@x.org,CARF;safety,restricted,annual,Governs A\n';
    const result = parseManifest(buf(csv));

    expect(result.columns).toEqual([
      'fileName',
      'title',
      'category',
      'documentNumber',
      'owner',
      'tags',
      'accessLevel',
      'reviewCadence',
      'description',
    ]);
    expect(result.errors).toHaveLength(0);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toEqual({
      rowNumber: 1,
      title: 'Policy A',
      fileName: 'a.pdf',
      category: 'Policies/Clinical',
      documentNumber: 'PP-1',
      owner: 'jane@x.org',
      tags: ['CARF', 'safety'],
      accessLevel: 'restricted',
      reviewCadence: 'annual',
      description: 'Governs A',
    });
  });

  it('matches headers case-insensitively and ignores unknown columns', () => {
    const csv = 'Title,FILENAME,extra\nHello,a.pdf,junk\n';
    const result = parseManifest(buf(csv));
    expect(result.rows[0]).toMatchObject({ title: 'Hello', fileName: 'a.pdf' });
  });

  it('records a per-row error for a blank title but keeps the valid rows', () => {
    const csv = 'title,fileName\n,orphan.pdf\nGood One,g.pdf\n';
    const result = parseManifest(buf(csv));
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].title).toBe('Good One');
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ rowNumber: 1, title: null, fileName: 'orphan.pdf' });
    expect(result.errors[0].message).toMatch(/title/i);
  });

  it('rejects an invalid accessLevel / reviewCadence as a per-row error', () => {
    const csv =
      'title,accessLevel,reviewCadence\n' +
      'Bad Access,top-secret,annual\n' +
      'Bad Cadence,restricted,weekly\n' +
      'Fine,confidential,quarterly\n';
    const result = parseManifest(buf(csv));
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].title).toBe('Fine');
    expect(result.errors.map((e) => e.rowNumber)).toEqual([1, 2]);
    expect(result.errors[0].message).toMatch(/accessLevel/);
    expect(result.errors[1].message).toMatch(/reviewCadence/);
  });

  it('leaves optional cells undefined and tags empty when blank', () => {
    const csv = 'title,fileName,tags\nOnly Title,,\n';
    const [row] = parseManifest(buf(csv)).rows;
    expect(row.fileName).toBeUndefined();
    expect(row.documentNumber).toBeUndefined();
    expect(row.tags).toEqual([]);
  });

  it('throws when the required title column is absent', () => {
    expect(() => parseManifest(buf('fileName,category\na.pdf,X\n'))).toThrow(/title/i);
  });

  it('throws on unparseable CSV', () => {
    // An unterminated quoted field is a hard CSV error.
    expect(() => parseManifest(buf('title\n"unterminated'))).toThrow(/CSV/i);
  });

  it('throws when the row count exceeds the maximum', () => {
    const rows = Array.from({ length: MAX_MANIFEST_ROWS + 1 }, (_, i) => `Doc ${i}`).join('\n');
    expect(() => parseManifest(buf(`title\n${rows}\n`))).toThrow(/maximum/i);
  });
});

describe('parseTags', () => {
  it('splits on ; and | , trims, and de-duplicates preserving order', () => {
    expect(parseTags('CARF; safety |CARF|policy')).toEqual(['CARF', 'safety', 'policy']);
  });
  it('returns an empty array for blank/undefined', () => {
    expect(parseTags(undefined)).toEqual([]);
    expect(parseTags('   ')).toEqual([]);
  });
});

describe('splitCategoryPath', () => {
  it('splits a slash path into trimmed, non-empty segments', () => {
    expect(splitCategoryPath('Policies & Procedures / Clinical')).toEqual([
      'Policies & Procedures',
      'Clinical',
    ]);
  });
  it('drops empty segments and handles a single name', () => {
    expect(splitCategoryPath('/Forms//')).toEqual(['Forms']);
    expect(splitCategoryPath(undefined)).toEqual([]);
  });
});

describe('titleFromFileName', () => {
  it('strips the directory and a single extension', () => {
    expect(titleFromFileName('folder/Seclusion_Policy.pdf')).toBe('Seclusion_Policy');
    expect(titleFromFileName('a\\b\\Report.final.docx')).toBe('Report.final');
  });
  it('falls back to the base name when stripping leaves nothing', () => {
    expect(titleFromFileName('.gitignore')).toBe('.gitignore');
  });
});
