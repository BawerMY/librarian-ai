import { DrizzleAdapter } from '@auth/drizzle-adapter'
import { eq } from 'drizzle-orm'
import NextAuth, { CredentialsSignin } from 'next-auth'
import Credentials from 'next-auth/providers/credentials'
import GitHub from 'next-auth/providers/github'

import { accounts, db, sessions, users, verificationTokens } from '@/db'
import { checkPasswordStrength, hashPassword, verifyPassword } from '@/lib/password'

/**
 * JWT sessions rather than database sessions.
 *
 * The Drizzle adapter still persists users and accounts (so `user_library`,
 * `editions.owner_user_id` and friends have a real FK target), but the session
 * itself is a signed cookie. That is what lets a Credentials provider coexist
 * with OAuth — Credentials cannot issue database sessions in Auth.js v5.
 */
export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: DrizzleAdapter(db, {
    usersTable: users,
    accountsTable: accounts,
    sessionsTable: sessions,
    verificationTokensTable: verificationTokens,
  }),
  session: { strategy: 'jwt' },
  pages: { signIn: '/signin' },
  providers: [
    // Add Google/Authentik here later — one entry, no other change.
    ...(process.env.AUTH_GITHUB_ID
      ? [
          GitHub({
            clientId: process.env.AUTH_GITHUB_ID,
            clientSecret: process.env.AUTH_GITHUB_SECRET!,
          }),
        ]
      : []),

    Credentials({
      id: 'password',
      name: 'Email and password',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(creds) {
        const email = normalizeEmail(String(creds?.email ?? ''))
        const password = String(creds?.password ?? '')
        if (!email || !password) throw new InvalidCredentials()

        const user = await db.query.users.findFirst({
          where: (u, { eq: is }) => is(u.email, email),
        })

        // Same error and roughly the same work whether the account is missing
        // or the password is wrong: distinguishing them turns the sign-in form
        // into an account-enumeration oracle.
        if (!user?.passwordHash) {
          await burnTime(password)
          throw new InvalidCredentials()
        }

        const ok = await verifyPassword(password, user.passwordHash)
        if (!ok) throw new InvalidCredentials()

        return { id: user.id, email: user.email, name: user.name, image: user.image }
      },
    }),
  ],
  callbacks: {
    jwt({ token, user }) {
      if (user?.id) token.sub = user.id
      return token
    },
    /**
     * Verify the account still exists.
     *
     * JWT sessions are self-contained, so deleting a user did NOT sign them
     * out: their cookie stayed valid for its full lifetime, reads came back
     * empty, and every write failed with a foreign-key violation on a user id
     * that no longer existed. Observed exactly that after deleting an account
     * from the admin panel.
     *
     * Costs one indexed primary-key lookup per session read, which is the
     * right trade against a token that outlives its account.
     */
    async session({ session, token }) {
      if (!token.sub) return session

      const user = await db.query.users.findFirst({
        where: (u, { eq: is }) => is(u.id, token.sub!),
        columns: { id: true },
      })

      if (!user) {
        // No id means every caller treats this as signed out, which is what
        // a deleted account is.
        return { ...session, user: { ...session.user, id: undefined as unknown as string } }
      }

      session.user.id = token.sub
      return session
    },
  },
})

/**
 * Create an account.
 *
 * Lives here rather than in a route handler so the sign-up and sign-in paths
 * share one notion of what a valid email and password are.
 */
export async function registerUser(
  rawEmail: string,
  password: string,
  name?: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const email = normalizeEmail(rawEmail)
  if (!email || !email.includes('@')) return { ok: false, error: 'Enter a valid email address.' }

  // Checked here rather than only in the UI: the sign-up form is a POST
  // endpoint, so hiding the form would not actually close registration.
  const { getSettings } = await import('@/lib/admin/data')
  const settings = await getSettings()
  if (settings.allow_registration !== 'true') {
    return { ok: false, error: 'New accounts are closed on this server.' }
  }

  const weak = checkPasswordStrength(password)
  if (weak) return { ok: false, error: weak }

  const existing = await db.query.users.findFirst({
    where: (u, { eq: is }) => is(u.email, email),
  })

  if (existing) {
    // An OAuth-created account can adopt a password; an account that already
    // has one must sign in instead.
    if (existing.passwordHash) {
      return { ok: false, error: 'That email already has an account. Sign in instead.' }
    }
    await db
      .update(users)
      .set({ passwordHash: await hashPassword(password) })
      .where(eq(users.id, existing.id))
    return { ok: true }
  }

  await db.insert(users).values({
    email,
    name: name?.trim() || email.split('@')[0],
    passwordHash: await hashPassword(password),
  })

  return { ok: true }
}

class InvalidCredentials extends CredentialsSignin {
  code = 'credentials'
}

function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase()
}

/** Keep the no-such-user path's timing in the same ballpark as a real verify. */
async function burnTime(password: string): Promise<void> {
  await hashPassword(password).catch(() => undefined)
}

/**
 * The single place the rest of the app learns who is asking.
 *
 * Every route that touches book content calls this and derives scope from the
 * result — never from the request body. See lib/retrieval/scope.ts.
 */
export async function requireUserId(): Promise<string> {
  const session = await auth()
  const id = session?.user?.id
  if (!id) throw new UnauthorizedError()
  return id
}

export class UnauthorizedError extends Error {
  constructor() {
    super('Unauthorized')
    this.name = 'UnauthorizedError'
  }
}
