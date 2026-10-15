import { sql } from 'drizzle-orm'

import { db } from '@/db'

/**
 * SCOPE DERIVATION — the authz boundary of the whole application.
 *
 * Every private book in the system lives in one Qdrant collection alongside
 * every other. Isolation comes entirely from the fact that a search filter
 * only ever names edition ids this function returned for the session user.
 *
 * Therefore:
 *   - this is the ONLY place scope is computed
 *   - it takes a userId and nothing else — no request body, no tool argument
 *   - callers may NARROW the result (intersect), never widen or replace it
 *
 * A request-supplied or model-supplied edition list would make every private
 * upload in the system readable by anyone. There is no such parameter here by
 * design, so there is nothing for a prompt injection to fill in.
 */

export type AllowedEdition = {
  editionId: string
  bookId: string
  kind: 'public' | 'private'
}

/**
 * One edition per work, preferring the user's own upload over the public
 * edition when they hold both.
 *
 * Without the DISTINCT ON, a user who added Meditations from the catalog and
 * later uploaded their own copy would get two editions of the same book in
 * scope, and a single passage would surface as two citation chips. Resolving
 * it here rather than de-duplicating results keeps the chat path simple.
 *
 * Private wins because it is their copy: their pagination, the edition they
 * would actually open to check a citation.
 */
export async function allowedEditions(userId: string): Promise<AllowedEdition[]> {
  const { rows } = await db.execute<{
    edition_id: string
    book_id: string
    kind: 'public' | 'private'
  }>(sql`
    SELECT DISTINCT ON (e.book_id)
           e.id          AS edition_id,
           e.book_id     AS book_id,
           e.kind        AS kind
      FROM user_library ul
      JOIN editions e ON e.id = ul.edition_id
     WHERE ul.user_id = ${userId}
       AND ul.selected
       AND ul.status = 'ready'
       AND e.index_status = 'ready'
     ORDER BY e.book_id, (e.kind = 'private') DESC
  `)

  return rows.map((r) => ({ editionId: r.edition_id, bookId: r.book_id, kind: r.kind }))
}

/**
 * Narrow an allowed set to a single work.
 *
 * Intersection, never substitution — that asymmetry is what makes it safe to
 * let the model ask for "only in Meditations". A bookId the user does not own
 * yields an empty scope, not somebody else's book.
 */
export function narrowToBook(allowed: AllowedEdition[], bookId: string): AllowedEdition[] {
  return allowed.filter((e) => e.bookId === bookId)
}

/** Raised when a search result escapes its scope. Should be unreachable. */
export class AuthzViolationError extends Error {
  constructor(
    readonly userId: string,
    readonly editionId: string,
  ) {
    super(`Search returned edition ${editionId} outside scope for user ${userId}`)
    this.name = 'AuthzViolationError'
  }
}
