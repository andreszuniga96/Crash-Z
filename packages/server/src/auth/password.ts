/**
 * @file password.ts
 * @description Bcrypt-based password hashing and verification utilities.
 *
 * Security choices:
 * - bcryptjs (pure-JS implementation) used over native bcrypt to eliminate
 *   native module compilation issues in Docker / cross-platform builds.
 * - Cost factor (rounds) = 12:
 *     - At 12 rounds: ~250ms per hash on a 3GHz CPU (modern hardware)
 *     - Balances security (brute-force resistance) with UX (< 300ms latency)
 *     - OWASP recommends ≥ 10; NIST allows up to the highest value that keeps
 *       response time under 1s. 12 is the industry sweet spot.
 * - Never store raw passwords in logs, error messages, or DB fields.
 */

import bcrypt from 'bcryptjs';

const BCRYPT_ROUNDS = 12;

/**
 * Hashes a plaintext password using bcrypt.
 * The salt is auto-generated and embedded in the returned hash string.
 *
 * @param plaintext - Raw password from the user registration form
 * @returns bcrypt hash string (60 chars, $2a$ format)
 * @throws Error if bcrypt fails (extremely rare, indicates resource exhaustion)
 */
export async function hashPassword(plaintext: string): Promise<string> {
  if (!plaintext || plaintext.length < 8) {
    throw new Error('Password must be at least 8 characters long');
  }
  if (plaintext.length > 72) {
    // bcrypt silently truncates passwords longer than 72 bytes.
    // We enforce this limit explicitly to avoid user confusion.
    throw new Error('Password must be 72 characters or fewer');
  }

  return bcrypt.hash(plaintext, BCRYPT_ROUNDS);
}

/**
 * Compares a plaintext password against a bcrypt hash.
 * Uses a constant-time comparison to prevent timing attacks.
 *
 * @param plaintext - Raw password from the login form
 * @param hash      - bcrypt hash retrieved from the database
 * @returns true if the password matches the hash
 */
export async function verifyPassword(
  plaintext: string,
  hash:      string,
): Promise<boolean> {
  if (!plaintext || !hash) return false;
  return bcrypt.compare(plaintext, hash);
}

/**
 * Validates password strength before hashing.
 * Returns an array of violation messages (empty = valid).
 *
 * Rules (per NIST SP 800-63B §5.1.1):
 * - Minimum 8 characters
 * - Maximum 72 characters (bcrypt limit)
 * - At least one uppercase letter
 * - At least one lowercase letter
 * - At least one digit
 * - At least one special character
 */
export function validatePasswordStrength(password: string): string[] {
  const errors: string[] = [];

  if (password.length < 8)  errors.push('Must be at least 8 characters');
  if (password.length > 72) errors.push('Must be 72 characters or fewer');
  if (!/[A-Z]/.test(password))           errors.push('Must contain at least one uppercase letter');
  if (!/[a-z]/.test(password))           errors.push('Must contain at least one lowercase letter');
  if (!/[0-9]/.test(password))           errors.push('Must contain at least one digit');
  if (!/[^A-Za-z0-9]/.test(password))    errors.push('Must contain at least one special character');

  return errors;
}
