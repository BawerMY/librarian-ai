import { eq, inArray } from 'drizzle-orm'

import { books, db, editions } from '@/db'
import { embedOne } from '@/lib/embed/ollama'
import { COLLECTION, qdrant, type ChunkPayload } from '@/lib/qdrant'

import { allowedEditions, AuthzViolationError, narrowToBook, type AllowedEdition } from './scope'

/**
 * THE CHOKEPOINT.
 *
 * Every path that reads book content — the chat tool, the MCP wrapper if one
 * is ever added, any admin utility — goes through this module. There is no
 * function here that can issue an unfiltered Qdrant query, and no code path
 * where `allowed` is optional or defaults to "everything".
 *
 * That shape is deliberate. A missing filter fails OPEN: it would silently
 * search every private book in the system and return plausible results. A
 * missing collection name merely throws. So the possibility is removed
 * structurally rather than guarded by review.
 */

export type Passage = {
  /** Per-turn citation id ("c1"). Assigned here so markers and chips agree. */
  id: string
  editionId: string
  bookId: string
  chunkIdx: number
  book: string
  author: string
  /** "Gummere translation, 1917" or "Your copy (EPUB)". */
  edition: string
  chapter: string | null
  section: string | null
  page: number | null
  posPct: number
  text: string
  score: number
}

export type SearchResult = {
  passages: Passage[]
  /**
   * An explicit sentence when there is nothing to return. A model steers far
   * better off a statement than off an empty array — and "say the books do
   * not cover it" is the behaviour the whole product depends on.
   */
  note?: string
}

export type SearchArgs = {
  userId: string
  query: string
  /** Optional narrowing to one work. Intersected, never substituted. */
  bookId?: string
  limit?: number
  /** Citation ids start here, so a second search in one turn continues c3, c4… */
  idOffset?: number
}

export async function searchBooks({
  userId,
  query,
  bookId,
  limit = 8,
  idOffset = 0,
}: SearchArgs): Promise<SearchResult> {
  const trimmed = query.trim()
  if (!trimmed) return { passages: [], note: 'Empty query.' }

  const allowed = await allowedEditions(userId)
  if (allowed.length === 0) {
    return {
      passages: [],
      note: 'The user has no searchable books yet. They need to add a public-domain book or upload their own copy.',
    }
  }

  // A bookId that matches nothing means the hint was wrong, not that the user
  // owns nothing. Falling back to their full allowed set is safe — it is still
  // an intersection with what Postgres granted, never a widening past it — and
  // it avoids the failure this caused in practice: the model invented an id,
  // narrowing emptied the scope, and the answer became "you don't have that
  // book" about a book that was indexed and present.
  let scope = allowed
  let ignoredBookId = false
  if (bookId) {
    const narrowed = narrowToBook(allowed, bookId)
    if (narrowed.length > 0) scope = narrowed
    else ignoredBookId = true
  }

  const scopeIds = scope.map((e) => e.editionId)
  const vector = await embedOne(trimmed, 'query')

  const res = await qdrant.query(COLLECTION, {
    query: vector,
    // Qdrant applies this DURING HNSW traversal, not after: excluded points
    // are never visited, never scored, and never consume `limit`. So this is
    // a real boundary, not a post-filter, and excluding 99.9% of the
    // collection costs nothing in recall.
    filter: { must: [{ key: 'edition_id', match: { any: scopeIds } }] },
    limit: Math.min(limit, 20),
    with_payload: true,
  })

  const hits = res.points ?? []
  if (hits.length === 0) {
    return {
      passages: [],
      note: 'No relevant passages found in the books this user has added.',
    }
  }

  const scopeNote = ignoredBookId
    ? `Note: bookId "${bookId}" is not in this user's library, so all of their books were searched instead.`
    : undefined

  // Defence in depth. Should be unreachable; if it ever fires, a filter was
  // built wrongly and that is a security incident, not a bad result.
  const scopeSet = new Set(scopeIds)
  for (const h of hits) {
    const p = h.payload as ChunkPayload | null
    if (!p) continue
    if (!scopeSet.has(p.edition_id)) throw new AuthzViolationError(userId, p.edition_id)
    if (p.visibility === 'private' && p.owner_id !== userId) {
      throw new AuthzViolationError(userId, p.edition_id)
    }
  }

  const labels = await editionLabels(scopeIds)

  const passages: Passage[] = hits.map((h, i) => {
    const p = h.payload as ChunkPayload
    const label = labels.get(p.edition_id)
    return {
      id: `c${idOffset + i + 1}`,
      editionId: p.edition_id,
      bookId: p.book_id,
      chunkIdx: p.chunk_idx,
      book: label?.title ?? 'Unknown',
      author: label?.author ?? 'Unknown',
      edition: label?.edition ?? '',
      chapter: p.chapter,
      section: p.section,
      page: p.page,
      posPct: p.pos_pct,
      text: p.text,
      score: Math.round(h.score * 1000) / 1000,
    }
  })

  return scopeNote ? { passages, note: scopeNote } : { passages }
}

/**
 * Search the PUBLIC catalog — books the user does not have yet.
 *
 * The only query in the system with no per-user scope, because it touches no
 * copyrighted content: public editions are public domain. Filtered strictly on
 * visibility so it can never surface a private edition, nor reveal that one
 * exists.
 */
export async function searchPublicCatalog(opts: {
  query: string
  excludeEditionIds?: string[]
  limit?: number
}): Promise<{ bookIds: string[]; byBook: Map<string, { chapter: string | null; text: string }> }> {
  const vector = await embedOne(opts.query.trim(), 'query')

  const res = await qdrant.query(COLLECTION, {
    query: vector,
    filter: { must: [{ key: 'visibility', match: { value: 'public' } }] },
    limit: Math.min(opts.limit ?? 24, 60),
    with_payload: true,
  })

  const exclude = new Set(opts.excludeEditionIds ?? [])
  const byBook = new Map<string, { chapter: string | null; text: string }>()

  for (const h of res.points ?? []) {
    const p = h.payload as ChunkPayload | null
    if (!p || p.visibility !== 'public') continue
    if (exclude.has(p.edition_id)) continue
    if (!byBook.has(p.book_id)) byBook.set(p.book_id, { chapter: p.chapter, text: p.text })
  }

  return { bookIds: [...byBook.keys()], byBook }
}

/**
 * Fetch chunks adjacent to one the user has already been shown.
 *
 * Bounded on purpose. Unbounded neighbour expansion would let a client walk
 * chunk_idx from 0 to N and reassemble a complete copyrighted book from chip
 * expansions — turning a search index into a reader. The per-request bound
 * here is half of it; the lifetime per-edition cap in lib/limits.ts is the
 * other half, since 200 bounded turns would otherwise add up to the same thing.
 */
export const MAX_NEIGHBOUR_WINDOW = 2

export async function expandPassage(opts: {
  userId: string
  editionId: string
  chunkIdx: number
  direction?: 'before' | 'after' | 'both'
}): Promise<{ chunks: { idx: number; text: string }[]; note?: string }> {
  // Re-derive scope rather than trusting the caller's editionId: the passage
  // may come from a persisted chat whose book has since been removed.
  const allowed = await allowedEditions(opts.userId)
  if (!allowed.some((e) => e.editionId === opts.editionId)) {
    return { chunks: [], note: 'That passage is no longer in the user’s library.' }
  }

  const dir = opts.direction ?? 'both'
  const from = dir === 'after' ? opts.chunkIdx : opts.chunkIdx - MAX_NEIGHBOUR_WINDOW
  const to = dir === 'before' ? opts.chunkIdx : opts.chunkIdx + MAX_NEIGHBOUR_WINDOW

  const rows = await db.query.chunks.findMany({
    where: (c, { and, eq, gte, lte }) =>
      and(eq(c.editionId, opts.editionId), gte(c.idx, Math.max(0, from)), lte(c.idx, to)),
    orderBy: (c, { asc }) => asc(c.idx),
    columns: { idx: true, text: true },
  })

  return { chunks: rows }
}

/* ------------------------------------------------------------------ */

type EditionLabel = { title: string; author: string; edition: string }

/**
 * Per-edition display metadata, joined once per search rather than stamped
 * onto all ~2000 chunk payloads of every book.
 */
async function editionLabels(editionIds: string[]): Promise<Map<string, EditionLabel>> {
  if (!editionIds.length) return new Map()

  const rows = await db
    .select({
      editionId: editions.id,
      kind: editions.kind,
      translator: editions.translator,
      year: editions.year,
      fileFormat: editions.fileFormat,
      title: books.title,
      author: books.author,
    })
    .from(editions)
    .innerJoin(books, eq(editions.bookId, books.id))
    .where(inArray(editions.id, editionIds))

  const out = new Map<string, EditionLabel>()
  for (const r of rows) {
    out.set(r.editionId, {
      title: r.title,
      author: r.author,
      edition: formatEditionLabel(r),
    })
  }
  return out
}

export function formatEditionLabel(e: {
  kind: 'public' | 'private'
  translator: string | null
  year: string | null
  fileFormat: 'epub' | 'pdf' | 'txt' | null
}): string {
  if (e.kind === 'private') {
    // Private uploads have no reliable edition metadata — EPUB dc: fields are
    // inconsistent and PDF metadata is usually junk. Say what is true instead
    // of guessing a translator.
    return e.fileFormat ? `Your copy (${e.fileFormat.toUpperCase()})` : 'Your copy'
  }
  const parts = [
    e.translator ? `${e.translator} translation` : null,
    e.year,
  ].filter(Boolean)
  return parts.join(', ')
}

export type { AllowedEdition }
