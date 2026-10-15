import { desc, eq } from 'drizzle-orm'
import Link from 'next/link'
import { connection } from 'next/server'
import { redirect } from 'next/navigation'

import { auth, signOut } from '@/auth'
import { chatSessions, db } from '@/db'
import { NewChatButton } from '@/components/chat/new-chat-button'
import { RecentChats } from '@/components/chat/recent-chats'
import { Logo } from '@/components/ui/logo'
import { getLibrary } from '@/lib/library'

/**
 * App shell. Sidebar at desktop widths, bottom tab bar on mobile — the two
 * navigation modes the design specifies.
 *
 * Everything inside this layout requires a session, enforced here once rather
 * than in each page.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // Must come before auth(). Auth.js touches crypto while validating the JWT,
  // and under Cache Components an unstable value reached before any dynamic
  // access aborts the render:
  //   "encountered the unstable value crypto.getRandomValues() while prerendering"
  // connection() is the documented way to say "this render is per-request",
  // and it has to be the first thing so nothing unstable precedes it.
  await connection()

  const session = await auth()
  const userId = session?.user?.id
  if (!userId) redirect('/signin')

  const [library, recents] = await Promise.all([
    getLibrary(userId),
    db
      .select({
        id: chatSessions.id,
        title: chatSessions.title,
        updatedAt: chatSessions.updatedAt,
      })
      .from(chatSessions)
      .where(eq(chatSessions.userId, userId))
      .orderBy(desc(chatSessions.updatedAt))
      .limit(12),
  ])

  const searchable = library.filter(
    (b) => b.status === 'ready' && b.indexStatus === 'ready' && b.selected,
  ).length

  const nav = [
    { href: '/chat', label: 'Ask' },
    { href: '/library', label: 'My books' },
    { href: '/settings', label: 'Settings' },
  ]

  async function doSignOut() {
    'use server'
    await signOut({ redirectTo: '/' })
  }

  return (
    // h-dvh, not min-h-screen: the chat needs a DEFINITE height to resolve
    // its own h-full against. With min-h-screen the height was only a floor,
    // so Chat could not fill it and the page grew taller than the window
    // instead of the message list scrolling — the composer scrolled away with
    // it. dvh rather than vh so mobile browser chrome is accounted for.
    <div className="flex h-dvh overflow-hidden bg-paper">
      {/* desktop sidebar */}
      <aside className="hidden w-[248px] shrink-0 flex-col gap-[22px] border-r border-line bg-sidebar px-3.5 py-5 md:flex">
        <div className="px-2">
          <Logo href="/chat" />
        </div>

        <NewChatButton className="flex h-10 shrink-0 items-center gap-2 rounded-md border border-line-strong bg-surface px-3 text-sm font-semibold text-ink transition-colors hover:border-accent">
          <span className="text-lg leading-none text-accent">+</span>
          New question
        </NewChatButton>

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

        <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
          <div className="eyebrow px-3 pb-1.5">Recent</div>
          <RecentChats
            initial={recents.map((r) => ({
              id: r.id,
              title: r.title,
              updatedAt: r.updatedAt.toISOString(),
              messages: 0,
              pending: false,
            }))}
          />
        </div>

        <div className="shrink-0 border-t border-line px-3 pt-3 text-[12.5px] leading-normal text-muted-2">
          <div className="font-semibold text-ink">
            {library.length} {library.length === 1 ? 'book' : 'books'}
          </div>
          <div>{searchable} searchable</div>
          <form action={doSignOut} className="mt-2">
            <button type="submit" className="text-[12.5px] text-faint underline hover:text-accent">
              Sign out
            </button>
          </form>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* mobile header */}
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-line bg-paper px-4 md:hidden">
          <Logo href="/chat" size="sm" />
          <NewChatButton className="flex h-9 items-center rounded-md border border-line-strong bg-surface px-3 text-[13px] font-semibold">
            + New
          </NewChatButton>
        </header>

        {/* Children own their scrolling. The chat scrolls its message list
            while pinning the composer; the other pages scroll as a whole.
            pb-16 keeps content clear of the mobile tab bar. */}
        <main className="flex min-h-0 flex-1 flex-col overflow-hidden pb-16 md:pb-0">
          {children}
        </main>

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

/**
 * Every page in this segment reads the session, so none can be prerendered.
 * `instant = false` permits a blocking route; `connection()` above is what
 * actually marks the render per-request. Both are needed: the first allows
 * blocking, the second establishes dynamism before Auth.js touches crypto.
 */
export const instant = false
