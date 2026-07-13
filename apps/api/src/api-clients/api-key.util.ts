import { randomBytes } from 'crypto';
import * as argon2 from 'argon2';

/**
 * Credential primitives for the public API's `clientId.secret` bearer scheme.
 *
 * Security contract (AGENTS.md §8): the secret is high-entropy and is stored ONLY
 * as an Argon2 hash — the plaintext is surfaced to an operator exactly once at
 * create/rotate time and is never recoverable. `clientId` is a NON-secret,
 * uniquely-indexed handle used to look up the row before the (constant-work)
 * Argon2 verification of the secret.
 */

/** Public, non-secret client handle prefix — recognizable in logs/headers. */
const CLIENT_ID_PREFIX = 'pmk';

/** Bytes of entropy behind the public client id (32 hex chars). */
const CLIENT_ID_BYTES = 16;

/** Bytes of entropy behind the secret (~43 base64url chars, >256-bit). */
const SECRET_BYTES = 32;

/** The parsed halves of a raw `clientId.secret` credential. */
export interface ParsedCredential {
  clientId: string;
  secret: string;
}

/** Generates a fresh, unique, non-secret client id (`pmk_<32-hex>`). */
export function generateClientId(): string {
  return `${CLIENT_ID_PREFIX}_${randomBytes(CLIENT_ID_BYTES).toString('hex')}`;
}

/** Generates a fresh high-entropy secret (URL-safe, no `.` so parsing is safe). */
export function generateSecret(): string {
  return randomBytes(SECRET_BYTES).toString('base64url');
}

/** Argon2-hashes a secret for at-rest storage (never store the plaintext). */
export function hashSecret(secret: string): Promise<string> {
  return argon2.hash(secret);
}

/**
 * Verifies a presented secret against a stored Argon2 hash. Returns false (never
 * throws) for a malformed/empty hash so a corrupt row simply fails auth.
 */
export async function verifySecret(hash: string, secret: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, secret);
  } catch {
    return false;
  }
}

/** Assembles the ready-to-use bearer credential shown once to the operator. */
export function buildCredential(clientId: string, secret: string): string {
  return `${clientId}.${secret}`;
}

/**
 * Splits a raw `clientId.secret` credential on its FIRST `.`. Both the id and the
 * secret are dot-free by construction, so the first separator is unambiguous.
 * Returns null when either half is missing/empty.
 */
export function parseCredential(raw: string | undefined | null): ParsedCredential | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const dot = trimmed.indexOf('.');
  if (dot <= 0) return null;
  const clientId = trimmed.slice(0, dot);
  const secret = trimmed.slice(dot + 1);
  if (!clientId || !secret) return null;
  return { clientId, secret };
}
