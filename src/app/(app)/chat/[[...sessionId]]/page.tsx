import { asc, eq } from 'drizzle-orm'
import { notFound } from 'next/navigation'
import { connection } from 'next/server'
import type { UIMessage } from 'ai'

import { auth } from '@/auth'
import { Chat } from '@/components/chat/chat'
import { chatMessages, db } from '@/db'
import type { CitationChip } from '@/lib/ai/tools'
import { getLibrary } from '@/lib/library'

/**
 * One route serves both a fresh chat (/chat) and a saved one
 * (/chat/<sessionId>) via an optional catch-all.
 *
 * Saved chats are rehydrated from `chat_messages`, including the citations
 * stored on each assistant row — retrieval is NOT re-run. Re-running it would
 * drift as the index changes and would break outright once the user removes a
 * book, leaving chips that open nothing.
 */
export default async function ChatPage({
  params,
}: {
  params: Promise<{ sessionId?: string[] }>
}) {
  // Before the crypto.randomUUID() below: under Cache Components an unstable
  // value reached before any dynamic access aborts the render.
  await connection()

  const session = await auth()
  const userId = session!.user!.id!

  const { sessionId: segments } = await params
  const sessionId = segments?.[0]

  const library = await getLibrary(userId)
  const searchableCount = library.filter(
    (b) => b.status === 'ready' && b.indexStatus === 'ready' && b.selected,
  ).length

  let initialMessages: UIMessage[] = []
  const initialCitations: Record<string, CitationChip> = {}

  if (sessionId) {
    const owned = await db.query.chatSessions.findFirst({
      where: (s, { and: all, eq: is }) => all(is(s.id, sessionId), is(s.userId, userId)),
    })
    // Ownership is checked here, not just in the API: a guessed session id
    // must 404 rather than render someone else's conversation.
    if (!owned) notFound()

    const rows = await db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.sessionId, sessionId))
      .orderBy(asc(chatMessages.createdAt))

    initialMessages = rows.map((r) => ({
      id: r.id,
      role: r.role,
      parts: [{ type: 'text' as const, text: r.content }],
    }))

    for (const r of rows) {
      Object.assign(initialCitations, (r.citations ?? {}) as Record<string, CitationChip>)
    }
  }

  // A fresh id per render for a new chat. It is Chat's React key, so
  // "New question" (which calls router.refresh()) mints a new one and
  // remounts the component with no messages. A constant key like 'new' would
  // leave the old conversation on screen.
  const chatId = sessionId ?? crypto.randomUUID()

  return (
    <Chat
      key={chatId}
      chatId={chatId}
      sessionId={sessionId}
      initialMessages={initialMessages}
      initialCitations={initialCitations}
      searchableCount={searchableCount}
    />
  )
}
