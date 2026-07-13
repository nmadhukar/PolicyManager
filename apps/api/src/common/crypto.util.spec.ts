import { decryptSecret, encryptSecret, isEncryptedPayload } from './crypto.util';

/**
 * AES-256-GCM secret encryption used for stored SMTP passwords (AGENTS.md §8:
 * secrets must never be plaintext at rest). These assert the round-trip, that
 * ciphertext never leaks the plaintext, and that tampering / wrong keys fail.
 */
describe('crypto.util', () => {
  const key = 'super-secret-app-key';

  it('round-trips a secret through encrypt/decrypt with the same key', () => {
    const plain = 'hunter2-smtp-password';
    const payload = encryptSecret(plain, key);
    expect(decryptSecret(payload, key)).toBe(plain);
  });

  it('never contains the plaintext in the ciphertext payload', () => {
    const plain = 'do-not-leak-me';
    const payload = encryptSecret(plain, key);
    expect(payload).not.toContain(plain);
    // Shape is iv:tag:data, all base64.
    expect(payload.split(':')).toHaveLength(3);
    expect(isEncryptedPayload(payload)).toBe(true);
  });

  it('produces a different ciphertext each time (random IV) for the same input', () => {
    const a = encryptSecret('same-input', key);
    const b = encryptSecret('same-input', key);
    expect(a).not.toBe(b);
    // ...but both still decrypt back to the original.
    expect(decryptSecret(a, key)).toBe('same-input');
    expect(decryptSecret(b, key)).toBe('same-input');
  });

  it('fails to decrypt with the wrong key (auth tag mismatch)', () => {
    const payload = encryptSecret('secret', key);
    expect(() => decryptSecret(payload, 'a-different-key')).toThrow();
  });

  it('fails to decrypt tampered ciphertext', () => {
    const payload = encryptSecret('secret', key);
    const [iv, tag, data] = payload.split(':');
    // Flip a byte in the data segment.
    const tampered = `${iv}:${tag}:${Buffer.from(data + 'AA', 'base64').toString('base64')}`;
    expect(() => decryptSecret(tampered, key)).toThrow();
  });

  it('handles empty and unicode secrets', () => {
    expect(decryptSecret(encryptSecret('', key), key)).toBe('');
    const unicode = 'pästwörd-🔐-Ω';
    expect(decryptSecret(encryptSecret(unicode, key), key)).toBe(unicode);
  });

  it('isEncryptedPayload rejects obvious non-payloads', () => {
    expect(isEncryptedPayload('plaintext')).toBe(false);
    expect(isEncryptedPayload('a:b')).toBe(false);
    expect(isEncryptedPayload(null)).toBe(false);
  });
});
