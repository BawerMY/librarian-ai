import Link from 'next/link'
import { redirect } from 'next/navigation'
import { connection } from 'next/server'

import { adminSignOut, isAdmin } from '@/lib/admin/session'

/**
 * Admin shell — same structure as the app: a 248px aside at desktop widths,
 * a bottom tab bar on mobile.
 *
 * Signalled as admin by the accent colour rather than a different layout: the
 * app's crimson is replaced by ink for the active state and the wordmark, so
 * it reads as the same product in a different mode rather than a second app.
 *
 * The (panel) route group exists so /admin/signin sits OUTSIDE this guard —
 * a sign-in page behind a sign-in guard cannot be reached.
 */
export default async function AdminPanelLayout({ children }: { children: React.ReactNode }) {
  await connection()
  if (!(await isAdmin())) redirect('/admin/signin')

  async function signOut() {
    'use server'
    await adminSignOut()
    redirect('/admin/signin')
  }

  const nav = [
    { href: '/admin/users', label: 'Users' },
    { href: '/admin/books', label: 'Books' },
    { href: '/admin/settings', label: 'Settings' },
  ] as const

  return (
    <div className="flex min-h-screen bg-paper">
      {/* desktop sidebar */}
      <aside className="hidden w-[248px] shrink-0 flex-col gap-[22px] border-r border-line bg-sidebar px-3.5 py-5 md:flex">
        <div className="flex items-center gap-2.5 px-2">
          <span className="grid h-[26px] w-[26px] place-items-center rounded bg-ink font-serif text-lg text-surface">
            L
          </span>
          <span className="font-serif text-[21px] font-medium tracking-[-0.01em]">LibrarianAI</span>
        </div>

        <div className="eyebrow px-2">Administration</div>

        <nav className="flex shrink-0 flex-col gap-0.5">
          {nav.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className="flex h-9 items-center rounded-md px-3 text-sm font-semibold text-ink transition-colors hover:bg-hover"
            >
              {n.label}
            </Link>
          ))}
        </nav>

        <div className="mt-auto flex shrink-0 flex-col gap-1.5 border-t border-line px-3 pt-3">
          <Link href="/" className="text-[12.5px] text-faint underline hover:text-accent">
            Back to the app
          </Link>
          <form action={signOut}>
            <button type="submit" className="text-[12.5px] text-faint underline hover:text-accent">
              Sign out
            </button>
          </form>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* mobile header */}
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-line bg-paper px-4 md:hidden">
          <div className="flex items-center gap-2">
            <span className="grid h-6 w-6 place-items-center rounded bg-ink font-serif text-base text-surface">
              L
            </span>
            <span className="font-serif text-[19px] font-medium">Admin</span>
          </div>
          <div className="flex items-center gap-3">
            <Link href="/" className="text-[13px] text-muted">
              App
            </Link>
            <form action={signOut}>
              <button type="submit" className="text-[13px] text-muted">
                Sign out
              </button>
            </form>
          </div>
        </header>

        <main className="min-h-0 flex-1 pb-16 md:pb-0">{children}</main>

        {/* mobile tab bar */}
        <nav className="fixed inset-x-0 bottom-0 flex h-16 border-t border-line bg-sidebar md:hidden">
          {nav.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className="flex flex-1 flex-col items-center justify-center gap-1 text-[11px] font-semibold text-ink"
            >
              {n.label}
            </Link>
          ))}
        </nav>
      </div>
    </div>
  )
}

export const instant = false
