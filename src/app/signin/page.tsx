import Link from 'next/link'
import { redirect } from 'next/navigation'
import { connection } from 'next/server'

import { auth, registerUser, signIn } from '@/auth'
import { Logo } from '@/components/ui/logo'

/**
 * Sign in or create an account.
 *
 * One page, two server actions, selected by `?mode=register`. Errors come back
 * through the query string rather than client state, so the form works without
 * JavaScript and a failed attempt does not lose the email already typed.
 */
export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ mode?: string; error?: string; email?: string }>
}) {
  await connection()
  const session = await auth()
  if (session?.user?.id) redirect('/chat')

  const { mode, error, email } = await searchParams
  const { getSettings } = await import('@/lib/admin/data')
  const registrationOpen = (await getSettings()).allow_registration === 'true'
  // Never show the form when registration is closed, even if ?mode=register
  // is typed by hand — registerUser refuses it anyway, but a form that is
  // guaranteed to fail is a worse experience than no form.
  const registering = mode === 'register' && registrationOpen
  const githubEnabled = Boolean(process.env.AUTH_GITHUB_ID)

  async function doSignIn(formData: FormData) {
    'use server'
    const em = String(formData.get('email') ?? '')
    const pw = String(formData.get('password') ?? '')
    try {
      await signIn('password', { email: em, password: pw, redirectTo: '/chat' })
    } catch (err) {
      // next/navigation performs navigation BY THROWING. Without this guard a
      // successful sign-in is caught here and reported as a failure.
      if (isRedirect(err)) throw err
      redirect(`/signin?error=invalid&email=${encodeURIComponent(em)}`)
    }
  }

  async function doRegister(formData: FormData) {
    'use server'
    const em = String(formData.get('email') ?? '')
    const pw = String(formData.get('password') ?? '')
    const name = String(formData.get('name') ?? '')

    const result = await registerUser(em, pw, name)
    if (!result.ok) {
      redirect(
        `/signin?mode=register&error=${encodeURIComponent(result.error)}&email=${encodeURIComponent(em)}`,
      )
    }
    try {
      await signIn('password', { email: em, password: pw, redirectTo: '/library' })
    } catch (err) {
      if (isRedirect(err)) throw err
      redirect('/signin?error=created')
    }
  }

  async function doGithub() {
    'use server'
    await signIn('github', { redirectTo: '/library' })
  }

  const message =
    error === 'invalid'
      ? 'That email and password do not match an account.'
      : error === 'created'
        ? 'Account created — sign in below.'
        : error

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-paper px-5 py-12">
      <div className="flex w-full max-w-[420px] flex-col gap-7">
        <Logo size="lg" />

        <div className="flex flex-col gap-3">
          <h1 className="m-0 text-[clamp(32px,5vw,42px)] leading-[1.05]">
            {registering ? 'Create your library' : 'Sign in'}
          </h1>
          <p className="m-0 text-[15px] leading-relaxed text-muted">
            Your library and uploads stay on this server.
          </p>
        </div>

        {message && (
          <p
            className={`m-0 rounded-md p-3 text-sm ${
              error === 'created'
                ? 'border border-ok-fg/20 bg-ok-bg text-ok-fg'
                : 'border border-accent/25 bg-accent-soft text-accent'
            }`}
          >
            {message}
          </p>
        )}

        {githubEnabled && (
          <form action={doGithub}>
            <button
              type="submit"
              className="h-12 w-full rounded-md bg-ink text-[15px] font-semibold text-surface transition-colors hover:bg-accent"
            >
              Continue with GitHub
            </button>
          </form>
        )}

        <form action={registering ? doRegister : doSignIn} className="flex flex-col gap-3">
          {registering && (
            <label className="flex flex-col gap-1.5 text-sm font-semibold">
              Name
              <input
                name="name"
                autoComplete="name"
                className="h-12 rounded-md border border-line-input bg-surface px-3 text-[15px] font-normal outline-none focus:border-accent"
              />
            </label>
          )}

          <label className="flex flex-col gap-1.5 text-sm font-semibold">
            Email
            <input
              name="email"
              type="email"
              required
              defaultValue={email ?? ''}
              autoComplete="email"
              className="h-12 rounded-md border border-line-input bg-surface px-3 text-[15px] font-normal outline-none focus:border-accent"
            />
          </label>

          <label className="flex flex-col gap-1.5 text-sm font-semibold">
            Password
            <input
              name="password"
              type="password"
              required
              minLength={registering ? 10 : undefined}
              autoComplete={registering ? 'new-password' : 'current-password'}
              className="h-12 rounded-md border border-line-input bg-surface px-3 text-[15px] font-normal outline-none focus:border-accent"
            />
            {registering && (
              <span className="text-[12px] font-normal text-faint">
                At least 10 characters. Length is the only rule — composition rules reliably push
                people toward weaker passwords.
              </span>
            )}
          </label>

          <button
            type="submit"
            className="h-12 rounded-md bg-accent text-[15px] font-semibold text-surface transition-colors hover:bg-accent-hover"
          >
            {registering ? 'Create account' : 'Sign in'}
          </button>
        </form>

        <p className="m-0 text-sm text-muted">
          {registering ? (
            <>
              Already have an account?{' '}
              <Link href="/signin" className="font-semibold text-accent underline">
                Sign in
              </Link>
            </>
          ) : (
            registrationOpen ? (
              <>
                No account yet?{' '}
                <Link href="/signin?mode=register" className="font-semibold text-accent underline">
                  Create one
                </Link>
              </>
            ) : (
              <>New accounts are closed on this server.</>
            )
          )}
        </p>
      </div>
    </div>
  )
}

/** next/navigation signals navigation by throwing; those must propagate. */
function isRedirect(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'digest' in err &&
    typeof (err as { digest?: unknown }).digest === 'string' &&
    (err as { digest: string }).digest.startsWith('NEXT_REDIRECT')
  )
}

export const instant = false
