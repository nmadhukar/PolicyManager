import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

/**
 * Authenticated symmetric encryption for secrets at rest (AGENTS.md §8: SMTP
 * passwords must never be stored in plaintext). Uses AES-256-GCM, which provides
 * confidentiality AND integrity — a wrong key or any tampering fails the auth tag.
 *
 * The caller-supplied `secret` (env APP_ENCRYPTION_KEY) may be any string; it is
 * SHA-256-hashed into an exact 32-byte key so operators aren't forced to provide a
 * precisely-sized value. The serialized payload is `iv:tag:data` (all base64), which
 * is self-describing enough to decrypt without extra bookkeeping.
 */

const IV_BYTES = 12; // 96-bit nonce, the GCM standard.
const ALGO = 'aes-256-gcm';

/** Derives a fixed 32-byte AES key from an arbitrary-length secret string. */
function deriveKey(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest();
}

/** Encrypts `plain` and returns a base64 `iv:tag:data` payload. */
export function encryptSecret(plain: string, secret: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, deriveKey(secret), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

/**
 * Decrypts a payload produced by {@link encryptSecret}. Throws if the payload is
 * malformed, the key is wrong, or the ciphertext/tag was tampered with (GCM
 * verification). Callers should treat any throw as "secret unavailable".
 */
export function decryptSecret(payload: string, secret: string): string {
  const parts = payload.split(':');
  if (parts.length !== 3) {
    throw new Error('Malformed encrypted payload');
  }
  const [ivB64, tagB64, dataB64] = parts;
  const decipher = createDecipheriv(ALGO, deriveKey(secret), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

/** True when `value` has the shape of an {@link encryptSecret} payload. */
export function isEncryptedPayload(value: unknown): boolean {
  return typeof value === 'string' && value.split(':').length === 3;
}
