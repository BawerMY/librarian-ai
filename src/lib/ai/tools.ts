import { tool, type UIMessageStreamWriter } from 'ai'
import { inArray } from 'drizzle-orm'
import { z } from 'zod'

import { books, db } from '@/db'
import { capQuote, checkReveal, NEIGHBOUR_WINDOW, recordReveal } from '@/lib/limits'
import { allowedEditions } from '@/lib/retrieval/scope'
import {
  expandPassage as expandPassageCore,
  searchBooks as searchBooksCore,
  searchPublicCatalog,
  type Passage,
} from '@/lib/retrieval/search'

import { SEARCH_BUDGET } from './loop'
import { formatPassagesForModel } from './prompt'

/**
 * Tool definitions, built PER REQUEST so that `userId` is captured in a
 * closure and appears in no input schema.
 *
 * This is the second of the two locks. The model can be persuaded — by a
 * poisoned PDF sitting in retrieved context, say — to *ask* for another user's
 * book. There is no argument on any of these tools that could carry the
 * request. The anti-pattern to never introduce is a module-level tool whose
 * schema takes a userId or an editionId list: then the model fills it in, and
 * prompt injection becomes privilege escalation.
 *
 * `bookId` is safe to expose because narrowing intersects with the allowed set
 * (see scope.narrowToBook) — a bookId the user does not own yields nothing.
 */

export type CitationStore = {
  /** citation id -> passage, accumulated across every search in one turn. */
  map: Map<string, Passage>
  add(passages: Passage[]): void
  /** Retrieval calls made this turn, against SEARCH_BUDGET. */
  searches: number
}

export function createCitationStore(): CitationStore {
  const map = new Map<string, Passage>()
  return {
    map,
    searches: 0,
    add(passages) {
      for (const p of passages) map.set(p.id, p)
    },
  }
}

export function buildTools(ctx: {
  userId: string
  store: CitationStore
  /**
   * Resolved passages are streamed to the client as they arrive, so citation
   * chips render with the text rather than after it.
   *
   * A GETTER, not a value: generation is started before the response stream
   * exists so it can outlive a disconnected client, which means the writer
   * may not be available yet when the tools are built. It is also absent
   * entirely once the client has gone away — the citations still reach the
   * database either way.
   */
  writer?: () => UIMessageStreamWriter | undefined
}) {
  const { userId, store } = ctx
  const writer = () => ctx.writer?.()

  return {
    searchBooks: tool({
      description:
        "Search the user's selected books for passages relevant to a question. " +
        'Call this before answering ANY question about book content. ' +
        'Call it multiple times with different phrasings when a question spans several ' +
        'topics or several books. Pass bookId only to restrict the search to one book.',
      inputSchema: z.object({
        query: z
          .string()
          .describe(
            'A sentence or phrase describing what to find, in natural language — not keywords. ' +
              'Semantic search matches meaning, so "worrying is worse than the thing itself" ' +
              'works far better than "worry fear anxiety".',
          ),
        bookId: z
          .string()
          .optional()
          .describe(
            'Omit this to search all of the user\'s books, which is almost always what you want. ' +
              'Only set it to restrict to ONE book, and only with a bookId copied exactly from ' +
              'the library list in the system prompt. A made-up id matches nothing.',
          ),
        limit: z.number().int().min(1).max(20).optional(),
      }),
      execute: async ({ query, bookId, limit }) => {
        // Budget, not a suggestion. A search-happy model will otherwise spend
        // every step retrieving and never produce an answer — see lib/ai/loop.ts.
        if (store.searches >= SEARCH_BUDGET) {
          return {
            passages: [],
            note:
              `Search budget for this question is used up (${SEARCH_BUDGET} searches). ` +
              `Answer now using the passages you already have.`,
          }
        }
        store.searches++

        const { passages, note } = await searchBooksCore({
          userId,
          query,
          bookId,
          limit: limit ?? 8,
          // Continue numbering so a second search in the same turn yields
          // c9, c10… rather than colliding with the first search's ids.
          idOffset: store.map.size,
        })

        if (note && !passages.length) return { passages: [], note }
        // A note WITH passages is advisory (e.g. an ignored bookId); pass it
        // through rather than dropping it, so the model learns the id was bad.

        // Cap what the model is GIVEN, not just what it prints. A model handed
        // three paragraphs will sometimes quote three paragraphs regardless of
        // instructions.
        const capped = passages.map((p) => ({ ...p, text: capQuote(p.text) }))

        /**
         * Lifetime reveal budget, per user per edition — CHECKED, not merely
         * recorded. Public-domain editions are unlimited; this only bites on
         * uploaded copyrighted text.
         *
         * Enforced by dropping passages from an exhausted edition rather than
         * refusing the whole search, so one capped book does not break
         * answering from the others. The cap exists to stop a book being
         * reassembled a few passages at a time; it is not a reason to stop
         * answering.
         */
        const editionIds = [...new Set(capped.map((p) => p.editionId))]
        const exhausted = new Set<string>()
        for (const editionId of editionIds) {
          const decision = await checkReveal(userId, editionId)
          if (!decision.allowed) exhausted.add(editionId)
        }

        const visible = capped.filter((p) => !exhausted.has(p.editionId))

        if (!visible.length) {
          return {
            passages: [],
            note:
              'The passages that match are all from a book whose excerpt limit for this user is ' +
              'already reached. Say that this book cannot be quoted further rather than answering ' +
              'from memory.',
          }
        }

        const byEdition = new Map<string, number[]>()
        for (const p of visible) {
          const list = byEdition.get(p.editionId) ?? []
          list.push(p.chunkIdx)
          byEdition.set(p.editionId, list)
        }
        for (const [editionId, idxs] of byEdition) {
          await recordReveal(userId, editionId, idxs)
        }

        store.add(visible)

        const w = writer()
        if (w) {
          try {
            w.write({ type: 'data-citations', data: visible.map(toCitationChip) })
          } catch {
            // The client went away mid-answer. Generation continues and the
            // citations are persisted with the message, so a refresh gets them.
          }
        }

        return {
          passages: formatPassagesForModel(visible),
          found: visible.length,
          ...(note ? { note } : {}),
          ...(exhausted.size
            ? { note: 'Some matching passages were withheld: that book has reached its excerpt limit for this user.' }
            : {}),
        }
      },
    }),

    expandPassage: tool({
      description:
        'Fetch the few chunks immediately before and/or after a passage you already cited, ' +
        'when you need surrounding context to answer precisely. Pass a citation id from an ' +
        'earlier searchBooks result in this conversation.',
      inputSchema: z.object({
        citationId: z.string().describe('A citation id such as "c1", from this conversation.'),
        direction: z.enum(['before', 'after', 'both']).optional(),
      }),
      execute: async ({ citationId, direction }) => {
        const passage = store.map.get(citationId)
        if (!passage) {
          return { note: `Unknown citation id "${citationId}". Use one from a searchBooks result.` }
        }

        // Checked BEFORE revealing. Walking neighbours is how a book would be
        // reassembled, so this is the one place the cap must refuse rather
        // than degrade.
        const budget = await checkReveal(userId, passage.editionId)
        if (!budget.allowed) {
          return {
            note:
              `No more of this book can be shown — ${budget.seen} of its ${budget.cap} allowed ` +
              `excerpts have already been used. Answer from the passages you have.`,
          }
        }

        const { chunks, note } = await expandPassageCore({
          userId,
          editionId: passage.editionId,
          chunkIdx: passage.chunkIdx,
          direction,
        })
        if (note) return { note }

        await recordReveal(
          userId,
          passage.editionId,
          chunks.map((c) => c.idx),
        )

        return {
          book: passage.book,
          chapter: passage.chapter,
          // Window is fixed server-side; the model cannot widen it, and the
          // lifetime cap stops many small windows adding up to the whole book.
          window: NEIGHBOUR_WINDOW,
          text: chunks.map((c) => c.text).join('\n\n'),
        }
      },
    }),

    bookInfo: tool({
      description:
        'Facts ABOUT a book rather than from it — when it was written, its subject, what ' +
        'else the author wrote. Use for questions the text itself cannot answer. Works for ' +
        'any book in the catalog, whether or not the user owns it. Answers from this tool ' +
        'need no citation marker.',
      inputSchema: z.object({
        bookId: z.string().describe('A bookId from the library list or a search result.'),
      }),
      execute: async ({ bookId }) => {
        const [book] = await db.select().from(books).where(inArray(books.id, [bookId]))
        if (!book) return { note: `No book with id "${bookId}" in the catalog.` }

        const allowed = await allowedEditions(userId)
        const owned = allowed.find((e) => e.bookId === bookId)

        return {
          title: book.title,
          author: book.author,
          written: book.yearWritten,
          category: book.category,
          publicDomain: book.isPd,
          inLibrary: Boolean(owned),
          editionKind: owned?.kind ?? null,
          // Open Library enrichment lands here once the catalog is seeded.
          details: book.olData ?? null,
        }
      },
    }),

    searchCatalog: tool({
      description:
        'Find books the user does NOT have yet, to suggest adding. Use when they ask whether ' +
        'you have anything on a topic, or when their own books do not cover a question. ' +
        'Returns public-domain books that can be added in one click, and copyrighted books ' +
        'where they would need to upload their own copy.',
      inputSchema: z.object({
        query: z.string().describe('A topic, title, or author in natural language.'),
      }),
      execute: async ({ query }) => {
        const allowed = await allowedEditions(userId)
        const ownedBookIds = new Set(allowed.map((e) => e.bookId))

        // Semantic pass over public-domain content the user doesn't own.
        const { bookIds } = await searchPublicCatalog({
          query,
          excludeEditionIds: allowed.map((e) => e.editionId),
          limit: 24,
        })

        const candidates = bookIds.filter((id) => !ownedBookIds.has(id)).slice(0, 5)
        const rows = candidates.length
          ? await db.select().from(books).where(inArray(books.id, candidates))
          : []

        // Metadata pass, for "do you have Kahneman?" — titles the catalog
        // knows but has no public text for.
        const byTitle = await db.query.books.findMany({
          where: (b, { ilike, or }) =>
            or(ilike(b.title, `%${query}%`), ilike(b.author, `%${query}%`)),
          limit: 5,
        })

        const seen = new Set<string>()
        const readyToAdd: { bookId: string; title: string; author: string }[] = []
        const needsYourCopy: { bookId: string; title: string; author: string }[] = []

        for (const b of [...rows, ...byTitle]) {
          if (seen.has(b.id) || ownedBookIds.has(b.id)) continue
          seen.add(b.id)
          const entry = { bookId: b.id, title: b.title, author: b.author }
          if (b.isPd) readyToAdd.push(entry)
          else needsYourCopy.push(entry)
        }

        if (!readyToAdd.length && !needsYourCopy.length) {
          return { note: `Nothing in the catalog matches "${query}".` }
        }

        return {
          readyToAdd,
          needsYourCopy,
          hint: needsYourCopy.length
            ? 'Books under copyright need the user to upload their own DRM-free copy.'
            : undefined,
        }
      },
    }),
  }
}

/* ------------------------------------------------------------------ */

export type CitationChip = {
  id: string
  bookId: string
  editionId: string
  chunkIdx: number
  book: string
  author: string
  edition: string
  /** Short chip label: "Letter XIII". */
  chapter: string | null
  /** Drawer label: "On Groundless Fears". */
  section: string | null
  page: number | null
  posPct: number
  text: string
}

export function toCitationChip(p: Passage): CitationChip {
  return {
    id: p.id,
    bookId: p.bookId,
    editionId: p.editionId,
    chunkIdx: p.chunkIdx,
    book: p.book,
    author: p.author,
    edition: p.edition,
    chapter: p.chapter,
    section: p.section,
    page: p.page,
    posPct: p.posPct,
    text: p.text,
  }
}
