import Link from 'next/link'
import { redirect } from 'next/navigation'
import { connection } from 'next/server'

import { adminConfigured, adminSignIn, isAdmin } from '@/lib/admin/session'

/**
 * Admin sign-in. One password, from the environment.
 *
 * No email field, because there is no admin account — nothing to identify,
 * only a secret to prove. That also means there is nothing here to enumerate.
 */
export default async function AdminSignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>
}) {
  await connection()
  if (await isAdmin()) redirect('/admin/users')

  const { error } = await searchParams
  const configured = adminConfigured()

  async function signIn(formData: FormData) {
    'use server'
    const ok = await adminSignIn(String(formData.get('password') ?? ''))
    redirect(ok ? '/admin/users' : '/admin/signin?error=1')
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-paper px-5 py-12">
      <div className="flex w-full max-w-[400px] flex-col gap-6">
        <div className="flex items-center gap-2.5">
          <span className="grid h-7 w-7 place-items-center rounded bg-ink font-serif text-[19px] text-surface">
            L
          </span>
          <span className="font-serif text-[22px] font-medium">Administration</span>
        </div>

        {!configured ? (
          <p className="m-0 rounded-md border border-accent/25 bg-accent-soft p-3 text-sm leading-relaxed text-accent">
            <code>ADMIN_PASSWORD</code> is not set, so the admin panel is disabled. Set it in{' '}
            <code>.env.local</code> and restart.
          </p>
        ) : (
          <>
            {error && (
              <p className="m-0 rounded-md border border-accent/25 bg-accent-soft p-3 text-sm text-accent">
                Wrong password.
              </p>
            )}
            <form action={signIn} className="flex flex-col gap-3">
              <label className="flex flex-col gap-1.5 text-sm font-semibold">
                Admin password
                <input
                  name="password"
                  type="password"
                  required
                  autoFocus
                  autoComplete="current-password"
                  className="h-12 rounded-md border border-line-input bg-surface px-3 text-[15px] font-normal outline-none focus:border-accent"
                />
              </label>
              <button
                type="submit"
                className="h-12 rounded-md bg-ink text-[15px] font-semibold text-surface transition-colors hover:bg-accent"
              >
                Enter
              </button>
            </form>
            <p className="m-0 text-xs leading-relaxed text-faint">
              This is not a user account. The admin cannot sign in to the app, hold books, or read
              anyone&apos;s uploaded text.
            </p>
          </>
        )}

        <Link href="/" className="text-sm text-muted underline">
          Back to the app
        </Link>
      </div>
    </div>
  )
}

export const instant = false
