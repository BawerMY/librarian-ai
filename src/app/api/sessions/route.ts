import { and, asc, desc, eq, sql } from 'drizzle-orm'

import { auth } from '@/auth'
import { chatMessages, chatSessions, db } from '@/db'

/**
 * The user's chat list, for the sidebar.
 *
 * Exists so "Recent" can update without a page reload: the sidebar is a
 * server component, so a new conversation did not appear there until the next
 * full navigation.
 *
 * `pending` marks a session whose last stored message is the user's, i.e. an
 * answer is still being generated (or generation died). That is what lets the
 * UI show an in-flight conversation after a refresh instead of pretending the
 * question was never asked.
 */
export async function GET() {
  const session = await auth()
  const userId = session?.user?.id
  if (!userId) return new Response('Unauthorized', { status: 401 })

  const rows = await db
    .select({
      id: chatSessions.id,
      title: chatSessions.title,
      updatedAt: chatSessions.updatedAt,
      messages: sql<number>`count(${chatMessages.id})::int`,
      replies: sql<number>`count(*) filter (where ${chatMessages.role} = 'assistant')::int`,
      lastRole: sql<string | null>`(
        select m2.role from chat_messages m2
        where m2.session_id = ${chatSessions.id}
        order by m2.created_at desc limit 1
      )`,
    })
    .from(chatSessions)
    .leftJoin(chatMessages, eq(chatMessages.sessionId, chatSessions.id))
    .where(eq(chatSessions.userId, userId))
    .groupBy(chatSessions.id)
    .orderBy(desc(chatSessions.updatedAt))
    .limit(30)

  return Response.json({
    sessions: rows.map((r) => ({
      id: r.id,
      title: r.title,
      updatedAt: r.updatedAt,
      messages: r.messages,
      pending: r.lastRole === 'user',
    })),
  })
}

/**
 * One session's messages — used to pick up an answer that finished while the
 * page was closed, without reloading the whole route.
 */
export async function POST(req: Request) {
  const session = await auth()
  const userId = session?.user?.id
  if (!userId) return new Response('Unauthorized', { status: 401 })

  const { sessionId } = (await req.json()) as { sessionId?: string }
  if (!sessionId) return Response.json({ error: 'sessionId required' }, { status: 400 })

  // Ownership re-checked: the id arrived over HTTP.
  const owned = await db.query.chatSessions.findFirst({
    where: (s, { and: all, eq: is }) => all(is(s.id, sessionId), is(s.userId, userId)),
  })
  if (!owned) return Response.json({ error: 'Not found' }, { status: 404 })

  const rows = await db
    .select()
    .from(chatMessages)
    .where(and(eq(chatMessages.sessionId, sessionId)))
    .orderBy(asc(chatMessages.createdAt))

  return Response.json({
    messages: rows.map((r) => ({
      id: r.id,
      role: r.role,
      content: r.content,
      citations: r.citations ?? {},
    })),
  })
}
