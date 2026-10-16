'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useMemo, useState } from 'react'

import { CHAT_UPDATED, type StartedChat } from './chat-events'

type Session = {
  id: string
  title: string | null
  updatedAt: string
  messages: number
  /** Last stored message is the user's — an answer is still being generated. */
  pending: boolean
}

/**
 * "Recent" in the sidebar.
 *
 * A client component on purpose. The sidebar is a server component, so a new
 * conversation did not appear in this list until the next full page load —
 * you asked a question and your own chat was missing from the history beside
 * it.
 *
 * It refreshes on three triggers: a short poll, the window regaining focus,
 * and a `librarian:chat-updated` event the Chat component dispatches when a
 * turn starts or finishes. The event is what makes it feel immediate; the poll
 * is what catches a turn that completed in another tab or after the page was
 * closed.
 *
 * When that event announces a brand-new chat it is also rendered optimistically.
 * The server creates the session row inside POST /api/chat, so a refetch fired
 * at the moment of asking still came back without it — the question appeared
 * in history only on a later poll.
 */
export function RecentChats({ initial }: { initial: Session[] }) {
  const [sessions, setSessions] = useState<Session[]>(initial)
  const [optimistic, setOptimistic] = useState<StartedChat | null>(null)
  const pathname = usePathname()

  // The optimistic row stands in only until the real one arrives; keeping both
  // would show the same conversation twice for a second or two.
  const shown = useMemo<Session[]>(() => {
    if (!optimistic || sessions.some((s) => s.id === optimistic.id)) return sessions
    return [
      {
        id: optimistic.id,
        title: optimistic.title,
        updatedAt: new Date().toISOString(),
        messages: 1,
        pending: true,
      },
      ...sessions,
    ]
  }, [sessions, optimistic])

  useEffect(() => {
    let alive = true

    async function load() {
      try {
        const res = await fetch('/api/sessions')
        if (!res.ok) return
        const data = (await res.json()) as { sessions: Session[] }
        if (!alive) return
        setSessions(data.sessions)
        // Retire the stand-in the moment the server knows the chat.
        setOptimistic((o) => (o && data.sessions.some((s) => s.id === o.id) ? null : o))
      } catch {
        // A failed poll is not worth surfacing; the next one will do.
      }
    }

    // Poll faster while something is mid-answer, slowly otherwise — a chat
    // list that updates every two seconds forever is wasted work.
    const anyPending = shown.some((s) => s.pending)
    const interval = setInterval(load, anyPending ? 3000 : 20000)

    const onFocus = () => void load()
    const onUpdated = (e: Event) => {
      const started = (e as CustomEvent<StartedChat | undefined>).detail
      if (started) setOptimistic(started)
      void load()
    }
    window.addEventListener('focus', onFocus)
    window.addEventListener(CHAT_UPDATED, onUpdated)

    return () => {
      alive = false
      clearInterval(interval)
      window.removeEventListener('focus', onFocus)
      window.removeEventListener(CHAT_UPDATED, onUpdated)
    }
  }, [shown])

  if (shown.length === 0) {
    return (
      <p className="m-0 px-3 text-[13px] leading-relaxed text-faint">
        Nothing yet. Ask a question.
      </p>
    )
  }

  return (
    <>
      {shown.map((s) => {
        const active = pathname === `/chat/${s.id}`
        return (
          <Link
            key={s.id}
            href={`/chat/${s.id}`}
            className={`flex items-start gap-1.5 rounded-md px-3 py-[7px] text-[13px] leading-[1.35] transition-colors hover:bg-hover ${
              active ? 'bg-active text-ink' : 'text-ink-3'
            }`}
          >
            {s.pending && (
              <span
                aria-label="still answering"
                title="Still answering"
                className="mt-[5px] h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent"
              />
            )}
            <span className="min-w-0 flex-1 truncate">{s.title ?? 'Untitled'}</span>
          </Link>
        )
      })}
    </>
  )
}
