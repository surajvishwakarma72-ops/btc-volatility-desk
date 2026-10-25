import crypto from 'node:crypto';

/**
 * Password hashing with Node's built-in scrypt (no extra dependency). Stored as `scrypt$N$r$p$salt$hash` (base64),
 * so the cost can be raised later and old hashes still verify.
 */
const N = 16384, R = 8, P = 1, KEYLEN = 32;

const scrypt = (pw: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> =>
  new Promise((resolve, reject) => crypto.scrypt(pw, salt, KEYLEN, { N: n, r, p, maxmem: 64 * 1024 * 1024 }, (e, k) => (e ? reject(e) : resolve(k))));

export async function hashPassword(pw: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, N, R, P);
  return ['scrypt', N, R, P, salt.toString('base64'), key.toString('base64')].join('$');
}

/** Constant-time check. A malformed or placeholder hash (such as the seeded "!") never verifies. */
export async function verifyPassword(pw: string, stored: string | null | undefined): Promise<boolean> {
  const parts = (stored ?? '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [n, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  if (![n, r, p].every((x) => Number.isInteger(x) && x > 0)) return false;
  try {
    const want = Buffer.from(parts[5]!, 'base64');
    const got = await scrypt(pw, Buffer.from(parts[4]!, 'base64'), n, r, p);
    return want.length === got.length && crypto.timingSafeEqual(want, got);
  } catch {
    return false;
  }
}

/** A hash to compare against when the email is unknown, so a wrong email and a wrong password take equally long. */
let decoy: Promise<string> | null = null;
export const decoyHash = (): Promise<string> => (decoy ??= hashPassword('not-a-real-password'));
