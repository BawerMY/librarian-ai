import { randomBytes, scrypt as scryptCb, type ScryptOptions, timingSafeEqual } from 'node:crypto'

/**
 * promisify() picks the overload without options, so the cost parameters would
 * be silently dropped. Wrapped by hand to keep them.
 */
function scrypt(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, options, (err, derived) =>
      err ? reject(err) : resolve(derived),
    )
  })
}

/**
 * Password hashing with scrypt from Node's standard library.
 *
 * scrypt rather than bcrypt/argon2 because it is memory-hard, built in, and
 * needs no native build step — one less thing to compile on the homelab, and
 * no dependency in the auth path.
 *
 * N = 16384 keeps memory at 128 * N * r = 16MB, under Node's default 32MB
 * maxmem. Raising N further would need maxmem passed explicitly on every call,
 * and silently throws if it is forgotten.
 */
const N = 16_384
const r = 8
const p = 1
const KEYLEN = 64
const SALT_BYTES = 16

/** Stored as "scrypt:N:r:p:<salt hex>:<derived hex>" so params can change later. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES)
  const derived = await scrypt(password.normalize('NFKC'), salt, KEYLEN, { N, r, p })
  return `scrypt:${N}:${r}:${p}:${salt.toString('hex')}:${derived.toString('hex')}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split(':')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false

  const [, nStr, rStr, pStr, saltHex, derivedHex] = parts
  const salt = Buffer.from(saltHex, 'hex')
  const expected = Buffer.from(derivedHex, 'hex')

  const derived = await scrypt(password.normalize('NFKC'), salt, expected.length, {
    N: Number(nStr),
    r: Number(rStr),
    p: Number(pStr),
  })

  // Constant-time: a length-dependent or short-circuiting compare leaks how
  // much of the hash matched.
  if (derived.length !== expected.length) return false
  return timingSafeEqual(derived, expected)
}

export type PasswordProblem = string | null

/**
 * Minimum viable policy: length only.
 *
 * Composition rules (a digit, a symbol, mixed case) push people toward
 * "Password1!" and measurably do not help. Length is the one constraint worth
 * enforcing here.
 */
export function checkPasswordStrength(password: string): PasswordProblem {
  if (password.length < 10) return 'Use at least 10 characters.'
  if (password.length > 200) return 'That is longer than 200 characters.'
  if (/^\s|\s$/.test(password)) return 'Remove the leading or trailing space.'
  return null
}
