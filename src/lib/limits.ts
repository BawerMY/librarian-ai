import { and, eq, sql } from 'drizzle-orm'

import { db, editions, revealLog } from '@/db'

/**
 * Structural limits on how much of a copyrighted book one user can ever see.
 *
 * These are the constraints that keep the app at the snippet end of the
 * spectrum rather than the "it's a reader" end. Authors Guild v. Google
 * upheld full-text indexing with snippet display partly BECAUSE of caps like
 * these — max snippets per search, a permanent blacklist of ~10% of each
 * book, and measures preventing reconstruction.
 *
 * They are counters and server-side truncation, not prompt instructions,
 * because a prompt instruction is a request and this needs to be a guarantee.
 */

/** Chunks either side of a cited passage that expandPassage will return. */
export const NEIGHBOUR_WINDOW = 2

/**
 * Share of one edition's chunks a single user may ever be shown, across all
 * sessions and all time. The Google Books structural limit, as a ceiling.
 *
 * Per-turn bounds alone are not enough: 200 bounded turns reconstruct a book
 * just as surely as one unbounded walk of chunk_idx from 0 to N.
 */
export const MAX_REVEAL_FRACTION = 0.2

/**
 * Longest verbatim quote an answer may carry, in characters.
 *
 * The design's "Quote exact passages" preference stays — this caps its length.
 * A chip showing one sentence with chapter and page is a citation; a chip
 * showing three paragraphs is a reader.
 */
export const MAX_QUOTE_CHARS = 320

export type RevealDecision = {
  allowed: boolean
  /** Distinct chunks of this edition this user has already been shown. */
  seen: number
  /** Ceiling for this edition. */
  cap: number
}

/**
 * Record that a user has been shown specific chunks, and report whether the
 * lifetime cap is now exhausted.
 *
 * Idempotent per (user, edition, chunk): re-reading an old chat does not
 * consume budget, because it reveals nothing the user has not already seen.
 */
export async function recordReveal(
  userId: string,
  editionId: string,
  chunkIdxs: number[],
): Promise<RevealDecision> {
  if (!chunkIdxs.length) return { allowed: true, seen: 0, cap: 0 }

  await db
    .insert(revealLog)
    .values(chunkIdxs.map((chunkIdx) => ({ userId, editionId, chunkIdx })))
    .onConflictDoNothing()

  return checkReveal(userId, editionId)
}

export async function checkReveal(userId: string, editionId: string): Promise<RevealDecision> {
  const [edition] = await db
    .select({ chunkCount: editions.chunkCount, kind: editions.kind })
    .from(editions)
    .where(eq(editions.id, editionId))

  // Public-domain editions carry no reconstruction risk — there is nothing to
  // protect. The cap exists for copyrighted text the user uploaded.
  if (!edition || edition.kind === 'public' || !edition.chunkCount) {
    return { allowed: true, seen: 0, cap: Number.POSITIVE_INFINITY }
  }

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(revealLog)
    .where(and(eq(revealLog.userId, userId), eq(revealLog.editionId, editionId)))

  const cap = Math.ceil(edition.chunkCount * MAX_REVEAL_FRACTION)
  return { allowed: count < cap, seen: count, cap }
}

/**
 * Trim a passage to the quote cap, on a sentence boundary where possible.
 *
 * Applied to what the model is GIVEN, not only to what it prints: a model
 * handed three paragraphs will sometimes quote three paragraphs however the
 * prompt is worded. Capping the input makes the limit structural.
 */
export function capQuote(text: string, max = MAX_QUOTE_CHARS): string {
  if (text.length <= max) return text

  const head = text.slice(0, max)
  const lastStop = Math.max(head.lastIndexOf('. '), head.lastIndexOf('? '), head.lastIndexOf('! '))
  if (lastStop > max * 0.5) return head.slice(0, lastStop + 1)

  const lastSpace = head.lastIndexOf(' ')
  return `${head.slice(0, lastSpace > 0 ? lastSpace : max)}…`
}
