import { eq } from 'drizzle-orm'

import { auth } from '@/auth'
import { chatSessions, db, editions, revealLog, userLibrary, users } from '@/db'
import { COLLECTION, qdrant } from '@/lib/qdrant'

/**
 * Account deletion — the Settings screen's irreversible action.
 *
 * Vectors are removed by an owner-scoped filter in a single call. That is
 * possible because private editions have exactly one owner (we never dedupe
 * uploads across users), which is what puts `owner_id` in the Qdrant payload
 * in the first place.
 *
 * Public editions are deliberately NOT touched: they are shared, contain only
 * public-domain text, and belong to no one. Deleting them would destroy
 * indexing work other users depend on.
 */
export async function DELETE() {
  const session = await auth()
  const userId = session?.user?.id
  if (!userId) return new Response('Unauthorized', { status: 401 })

  // Vectors first. If this fails we abort with the database intact, leaving a
  // retryable state rather than orphaned points nothing can attribute.
  await qdrant.delete(COLLECTION, {
    wait: true,
    filter: { must: [{ key: 'owner_id', match: { value: userId } }] },
  })

  // Private editions cascade to their chunks and edition_text.
  await db.delete(editions).where(eq(editions.ownerUserId, userId))
  await db.delete(revealLog).where(eq(revealLog.userId, userId))
  await db.delete(userLibrary).where(eq(userLibrary.userId, userId))
  await db.delete(chatSessions).where(eq(chatSessions.userId, userId))
  await db.delete(users).where(eq(users.id, userId))

  return Response.json({ ok: true })
}

export async function PATCH(req: Request) {
  const session = await auth()
  const userId = session?.user?.id
  if (!userId) return new Response('Unauthorized', { status: 401 })

  const { name } = (await req.json()) as { name?: string }
  if (typeof name !== 'string') {
    return Response.json({ error: 'name required' }, { status: 400 })
  }

  await db.update(users).set({ name: name.trim() || null }).where(eq(users.id, userId))
  return Response.json({ ok: true })
}
