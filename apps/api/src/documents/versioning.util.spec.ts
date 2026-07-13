import { computeNextVersionNumber, sha256Hex } from './versioning.util';

describe('sha256Hex', () => {
  it('computes the known SHA-256 of a byte payload (hex, lowercase)', () => {
    // Well-known vector: sha256("abc").
    expect(sha256Hex(Buffer.from('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('computes the SHA-256 of the empty payload', () => {
    expect(sha256Hex(Buffer.from(''))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('is deterministic and content-addressed (same bytes -> same digest)', () => {
    const a = sha256Hex(Buffer.from('policy bytes'));
    const b = sha256Hex(Buffer.from('policy bytes'));
    expect(a).toBe(b);
    expect(sha256Hex(Buffer.from('policy bytez'))).not.toBe(a);
  });
});

describe('computeNextVersionNumber', () => {
  it('starts a brand-new document at version 1', () => {
    expect(computeNextVersionNumber(null)).toBe(1);
    expect(computeNextVersionNumber(undefined)).toBe(1);
  });

  it('increments monotonically from the current maximum', () => {
    expect(computeNextVersionNumber(1)).toBe(2);
    expect(computeNextVersionNumber(7)).toBe(8);
  });
});
