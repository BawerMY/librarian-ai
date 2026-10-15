import Link from 'next/link'
import { connection } from 'next/server'

import { auth } from '@/auth'

/**
 * The only part of the landing page that depends on who is asking.
 *
 * Isolated so the rest of the page stays prerenderable under Cache
 * Components: the hero, the three steps and the footer are identical for
 * everyone, and blocking all of that on a session lookup would be a slower
 * first paint for no gain.
 */
export async function HeaderAuth() {
  await connection()
  const session = await auth()

  if (session?.user?.id) {
    return (
      <Link
        href="/chat"
        className="flex h-10 items-center rounded-md bg-ink px-4 text-sm font-semibold text-surface transition-colors hover:bg-accent"
      >
        Open library
      </Link>
    )
  }

  return (
    <>
      <Link href="/signin" className="flex h-10 items-center px-3 text-sm font-semibold text-ink">
        Sign in
      </Link>
      <Link
        href="/signin"
        className="flex h-10 items-center rounded-md bg-ink px-4 text-sm font-semibold text-surface transition-colors hover:bg-accent"
      >
        Get started
      </Link>
    </>
  )
}

/** Same height as the real buttons, so the header does not jump. */
export function HeaderAuthFallback() {
  return <div className="h-10 w-[180px]" aria-hidden />
}
