import * as argon2 from 'argon2';
import {
  buildCredential,
  generateClientId,
  generateSecret,
  hashSecret,
  parseCredential,
  verifySecret,
} from './api-key.util';

/**
 * Unit contract for the API credential primitives (AGENTS.md §8): high-entropy,
 * unique, and stored ONLY as an Argon2 hash that verifies correctly and rejects
 * anything else. Parsing of `clientId.secret` must be unambiguous.
 */
describe('api-key.util', () => {
  describe('generateClientId', () => {
    it('produces the pmk_<32-hex> shape and is unique per call', () => {
      const a = generateClientId();
      const b = generateClientId();
      expect(a).toMatch(/^pmk_[0-9a-f]{32}$/);
      expect(b).toMatch(/^pmk_[0-9a-f]{32}$/);
      expect(a).not.toBe(b);
    });
  });

  describe('generateSecret', () => {
    it('produces a long, URL-safe, dot-free, unique secret', () => {
      const a = generateSecret();
      const b = generateSecret();
      expect(a.length).toBeGreaterThanOrEqual(32);
      expect(a).toMatch(/^[A-Za-z0-9_-]+$/); // base64url — importantly no '.'
      expect(a).not.toContain('.');
      expect(a).not.toBe(b);
    });
  });

  describe('hashSecret / verifySecret', () => {
    it('stores an Argon2 hash (not the plaintext) that verifies the original', async () => {
      const secret = generateSecret();
      const hash = await hashSecret(secret);
      expect(hash).not.toContain(secret);
      expect(hash.startsWith('$argon2')).toBe(true);
      expect(await verifySecret(hash, secret)).toBe(true);
    });

    it('rejects a wrong secret', async () => {
      const hash = await hashSecret('the-real-secret');
      expect(await verifySecret(hash, 'not-it')).toBe(false);
    });

    it('returns false (never throws) for a malformed hash', async () => {
      await expect(verifySecret('not-a-hash', 'x')).resolves.toBe(false);
    });

    it('interops with the same argon2 the seed/auth layer uses', async () => {
      const hash = await hashSecret('interop');
      expect(await argon2.verify(hash, 'interop')).toBe(true);
    });
  });

  describe('buildCredential / parseCredential', () => {
    it('round-trips a clientId.secret credential', () => {
      const clientId = generateClientId();
      const secret = generateSecret();
      const cred = buildCredential(clientId, secret);
      expect(cred).toBe(`${clientId}.${secret}`);
      expect(parseCredential(cred)).toEqual({ clientId, secret });
    });

    it('splits on the FIRST dot only', () => {
      // A secret can never contain a dot, but be defensive: the id is the head.
      expect(parseCredential('pmk_abc.part1.part2')).toEqual({
        clientId: 'pmk_abc',
        secret: 'part1.part2',
      });
    });

    it('rejects malformed credentials', () => {
      expect(parseCredential('')).toBeNull();
      expect(parseCredential(undefined)).toBeNull();
      expect(parseCredential(null)).toBeNull();
      expect(parseCredential('no-dot-here')).toBeNull();
      expect(parseCredential('.leadingdot')).toBeNull();
      expect(parseCredential('trailingdot.')).toBeNull();
    });

    it('trims surrounding whitespace', () => {
      expect(parseCredential('  a.b  ')).toEqual({ clientId: 'a', secret: 'b' });
    });
  });
});
