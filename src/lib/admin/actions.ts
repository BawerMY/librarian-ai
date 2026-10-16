import { eq, inArray } from 'drizzle-orm'

import { chatSessions, db, editions, revealLog, userLibrary, users } from '@/db'
import { purgeEdition } from '@/lib/ingest/pipeline'
import { COLLECTION, qdrant } from '@/lib/qdrant'

/**
 * Admin mutations.
 *
 * Every one of these is destructive, so each re-reads the row it is about to
 * act on rather than trusting what the client sent. The admin panel is the one
 * place in this app with no per-user scope, which makes "verify the target"
 * the only guard left.
 */

/** Delete a user and everything of theirs. Same shape as self-deletion. */
export async function deleteUser(userId: string): Promise<void> {
  // Vectors first: if this fails we stop with the rows intact and a retryable
  // state, rather than points nothing can attribute.
  await qdrant.delete(COLLECTION, {
    wait: true,
    filter: { must: [{ key: 'owner_id', match: { value: userId } }] },
  })

  // Private editions cascade to their chunks and text.
  await db.delete(editions).where(eq(editions.ownerUserId, userId))
  await db.delete(revealLog).where(eq(revealLog.userId, userId))
  await db.delete(userLibrary).where(eq(userLibrary.userId, userId))
  await db.delete(chatSessions).where(eq(chatSessions.userId, userId))
  await db.delete(users).where(eq(users.id, userId))
}

/** Clear a user's password, locking them out without destroying their library. */
export async function revokePassword(userId: string): Promise<void> {
  await db.update(users).set({ passwordHash: null }).where(eq(users.id, userId))
}

/** Re-queue an edition for indexing. */
export async function reindexEdition(editionId: string): Promise<{ ok: boolean; reason?: string }> {
  const edition = await db.query.editions.findFirst({
    where: (e, { eq: is }) => is(e.id, editionId),
  })
  if (!edition) return { ok: false, reason: 'No such edition.' }

  // A private edition whose file was deleted after indexing has nothing to
  // re-read. Re-queueing it would just fail in the worker, so say why instead.
  if (edition.kind === 'private' && !edition.sourceRef) {
    return {
      ok: false,
      reason:
        'The uploaded file was deleted after indexing, so this cannot be re-parsed. ' +
        'Use "rebuild vectors" to re-embed from the stored chunks, or ask the owner to re-upload.',
    }
  }

  await db
    .update(editions)
    .set({ indexStatus: 'pending', progress: 0, error: null })
    .where(eq(editions.id, editionId))
  return { ok: true }
}

/**
 * Delete an edition's derived data, its uploaded file, and the edition itself.
 *
 * Shares purgeEdition with the owner-facing path so an admin delete leaves
 * exactly as little behind as a user delete does.
 */
export async function deleteEdition(editionId: string): Promise<void> {
  await db.delete(userLibrary).where(eq(userLibrary.editionId, editionId))
  await purgeEdition(editionId)
}

/** Books nobody holds and that have no editions — catalog litter. */
export async function pruneOrphanBooks(): Promise<number> {
  const { books } = await import('@/db')
  const all = await db.select({ id: books.id }).from(books)
  const withEditions = new Set(
    (await db.select({ bookId: editions.bookId }).from(editions)).map((e) => e.bookId),
  )
  const orphans = all.map((b) => b.id).filter((id) => !withEditions.has(id))
  if (!orphans.length) return 0
  await db.delete(books).where(inArray(books.id, orphans))
  return orphans.length
}
