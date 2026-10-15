import { createHmac, timingSafeEqual } from 'node:crypto'
import { cookies } from 'next/headers'

/**
 * Admin authentication — deliberately NOT Auth.js, and deliberately not a user.
 *
 * The admin is not a row in the users table. It cannot sign in to the app,
 * appear in a library, own an edition or be granted a book. That separation is
 * the point: the whole app derives scope from a session user id, and an admin
 * that *was* a user would be one bug away from that id reaching
 * allowedEditions() and widening a search.
 *
 * So: a password from the environment, and a signed cookie that says nothing
 * except "this browser proved it knows the password, until <expiry>". There is
 * no admin identity to confuse with a user identity.
 */

const COOKIE = 'librarian_admin'

function secret(): string {
  const s = process.env.AUTH_SECRET
  if (!s) throw new Error('AUTH_SECRET is required to sign the admin session')
  return s
}

function adminPassword(): string | null {
  const p = process.env.ADMIN_PASSWORD
  return p && p.length > 0 ? p : null
}

export function adminConfigured(): boolean {
  return adminPassword() !== null
}

function sign(payload: string): string {
  return createHmac('sha256', secret()).update(payload).digest('base64url')
}

/** Token is "<expiryMs>.<hmac>" — no identity, nothing to enumerate. */
function mint(): string {
  const hours = Number(process.env.ADMIN_SESSION_HOURS ?? 12)
  const expiry = Date.now() + (Number.isFinite(hours) ? hours : 12) * 3600_000
  const payload = String(expiry)
  return `${payload}.${sign(payload)}`
}

function verify(token: string | undefined): boolean {
  if (!token) return false
  const dot = token.lastIndexOf('.')
  if (dot <= 0) return false

  const payload = token.slice(0, dot)
  const provided = token.slice(dot + 1)
  const expected = sign(payload)

  // Constant-time, and length-checked first because timingSafeEqual throws on
  // a length mismatch.
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false

  const expiry = Number(payload)
  return Number.isFinite(expiry) && expiry > Date.now()
}

/**
 * Check the password and start a session.
 *
 * Compared in constant time against the env value. The comparison is padded
 * via HMAC so the work does not depend on how many characters matched — a
 * plain `===` on secrets leaks the prefix length through timing.
 */
export async function adminSignIn(password: string): Promise<boolean> {
  const expected = adminPassword()
  if (!expected) return false

  const given = sign(`pw:${password}`)
  const want = sign(`pw:${expected}`)
  if (!timingSafeEqual(Buffer.from(given), Buffer.from(want))) return false

  const jar = await cookies()
  jar.set(COOKIE, mint(), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: Number(process.env.ADMIN_SESSION_HOURS ?? 12) * 3600,
  })
  return true
}

export async function adminSignOut(): Promise<void> {
  const jar = await cookies()
  jar.delete(COOKIE)
}

export async function isAdmin(): Promise<boolean> {
  const jar = await cookies()
  return verify(jar.get(COOKIE)?.value)
}

export class NotAdminError extends Error {
  constructor() {
    super('Admin access required')
    this.name = 'NotAdminError'
  }
}

/** For API routes: throws rather than returning a boolean nobody checks. */
export async function requireAdmin(): Promise<void> {
  if (!(await isAdmin())) throw new NotAdminError()
}
