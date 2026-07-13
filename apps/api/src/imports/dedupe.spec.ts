import { duplicateMessage, findDuplicate } from './dedupe';

/**
 * Unit tests for the duplicate-detection decision core (AGENTS.md §6). Precedence
 * MUST be documentNumber → checksum → title+fileName, and a candidate with no
 * lookup hits is new.
 */
describe('findDuplicate', () => {
  it('returns null when nothing matches', () => {
    expect(findDuplicate({})).toBeNull();
    expect(
      findDuplicate({ byDocumentNumber: null, byChecksum: null, byTitleFileName: null }),
    ).toBeNull();
  });

  it('matches by documentNumber first (highest priority)', () => {
    const result = findDuplicate({
      byDocumentNumber: { id: 'doc-num' },
      byChecksum: { documentId: 'doc-sum' },
      byTitleFileName: { id: 'doc-tf' },
    });
    expect(result).toEqual({ documentId: 'doc-num', reason: 'documentNumber' });
  });

  it('falls back to checksum when there is no number match', () => {
    const result = findDuplicate({
      byDocumentNumber: null,
      byChecksum: { documentId: 'doc-sum' },
      byTitleFileName: { id: 'doc-tf' },
    });
    expect(result).toEqual({ documentId: 'doc-sum', reason: 'checksum' });
  });

  it('falls back to title+fileName last', () => {
    const result = findDuplicate({ byTitleFileName: { id: 'doc-tf' } });
    expect(result).toEqual({ documentId: 'doc-tf', reason: 'title+fileName' });
  });
});

describe('duplicateMessage', () => {
  it('gives a distinct, human-readable reason per rule', () => {
    expect(duplicateMessage('documentNumber')).toMatch(/document number/i);
    expect(duplicateMessage('checksum')).toMatch(/checksum/i);
    expect(duplicateMessage('title+fileName')).toMatch(/title and file name/i);
  });
});
