import { and, desc, eq } from 'drizzle-orm'

import { books, db, editions, userLibrary } from '@/db'
import type { LibraryEntry } from '@/lib/ai/prompt'
import { purgeEdition } from '@/lib/ingest/pipeline'
import { formatEditionLabel } from '@/lib/retrieval/search'

export type LibraryRow = {
  bookId: string
  editionId: string
  title: string
  author: string
  color: string | null
  coverUrl: string | null
  kind: 'public' | 'private'
  edition: string
  status: 'ready' | 'needs_file'
  selected: boolean
  indexStatus: 'awaiting_file' | 'pending' | 'parsing' | 'embedding' | 'ready' | 'failed' | 'deleting'
  progress: number
  error: string | null
  fileFormat: 'epub' | 'pdf' | 'txt' | null
  isPd: boolean
}

/**
 * Everything in a user's library, including books still indexing and books
 * waiting on a file. Backs both the My Books shelf and the system prompt.
 *
 * Note this is NOT the authz path — that is allowedEditions() in
 * retrieval/scope.ts, which filters harder (selected, ready) and resolves one
 * edition per work. This one shows the user their shelf; that one decides what
 * can be read.
 */
export async function getLibrary(userId: string): Promise<LibraryRow[]> {
  const rows = await db
    .select({
      bookId: books.id,
      editionId: editions.id,
      title: books.title,
      author: books.author,
      color: books.color,
      coverUrl: books.coverUrl,
      isPd: books.isPd,
      kind: editions.kind,
      translator: editions.translator,
      year: editions.year,
      fileFormat: editions.fileFormat,
      status: userLibrary.status,
      selected: userLibrary.selected,
      indexStatus: editions.indexStatus,
      progress: editions.progress,
      error: editions.error,
      addedAt: userLibrary.addedAt,
    })
    .from(userLibrary)
    .innerJoin(editions, eq(userLibrary.editionId, editions.id))
    .innerJoin(books, eq(editions.bookId, books.id))
    .where(eq(userLibrary.userId, userId))
    .orderBy(desc(userLibrary.addedAt))

  return rows.map((r) => ({
    bookId: r.bookId,
    editionId: r.editionId,
    title: r.title,
    author: r.author,
    color: r.color,
    coverUrl: r.coverUrl,
    isPd: r.isPd,
    kind: r.kind,
    edition: formatEditionLabel(r),
    status: r.status,
    selected: r.selected,
    indexStatus: r.indexStatus,
    progress: r.progress,
    error: r.error,
    fileFormat: r.fileFormat,
  }))
}

export type AddResult = {
  editionId: string
  status: 'ready' | 'needs_file'
  /** True when this add triggered indexing work nobody had paid for yet. */
  indexing: boolean
}

/**
 * Add a book to a user's library.
 *
 * The public edition is created HERE, lazily, on the first add — not at seed
 * time. Seeding 15 editions up front would queue hours of embedding for books
 * nobody asked for. So the first person to add Walden pays the indexing cost
 * once and everybody after them gets a single row.
 */
export async function addBook(userId: string, bookId: string): Promise<AddResult> {
  // An "ol:/works/OL123W" id comes from a live Open Library search and has no
  // local row yet. Adopting it is also where we discover whether Gutenberg can
  // supply the text, which decides one-click-add versus upload-your-own.
  const resolvedId = bookId.startsWith('ol:') ? await adoptOpenLibraryWork(bookId) : bookId

  const book = await db.query.books.findFirst({
    where: (b, { eq: isEq }) => isEq(b.id, resolvedId),
  })
  if (!book) throw new NotFoundError(`No book "${bookId}"`)

  const effectiveBookId = book.id

  if (book.isPd && book.gutenbergId !== null) {
    const editionId = `ed_pd_${book.gutenbergId}`
    const bookId = effectiveBookId

    const existing = await db.query.editions.findFirst({
      where: (e, { eq: isEq }) => isEq(e.id, editionId),
    })

    if (!existing) {
      await db
        .insert(editions)
        .values({
          id: editionId,
          bookId,
          kind: 'public',
          lang: 'en',
          source: 'gutenberg',
          sourceRef: String(book.gutenbergId),
          fileFormat: 'epub',
          indexStatus: 'pending',
        })
        .onConflictDoNothing()
    }

    await db
      .insert(userLibrary)
      .values({ userId, editionId, status: 'ready', selected: true })
      .onConflictDoNothing()

    return { editionId, status: 'ready', indexing: !existing || existing.indexStatus !== 'ready' }
  }

  // Copyrighted, or public domain but absent from our text source. Either way
  // we cannot supply the words, so a placeholder edition holds the user's slot
  // until they upload their own copy.
  const editionId = `ed_pv_${userId}_${effectiveBookId}`.slice(0, 200)

  await db
    .insert(editions)
    .values({
      id: editionId,
      bookId: effectiveBookId,
      kind: 'private',
      ownerUserId: userId,
      lang: 'en',
      source: 'upload',
      // 'awaiting_file' rather than 'pending': the worker claims 'pending',
      // and there is nothing yet to index.
      indexStatus: 'awaiting_file',
    })
    .onConflictDoNothing()

  await db
    .insert(userLibrary)
    .values({ userId, editionId, status: 'needs_file', selected: true })
    .onConflictDoNothing()

  return { editionId, status: 'needs_file', indexing: false }
}

/**
 * Turn an Open Library search result into a local catalog row.
 *
 * The important step is the Gutenberg lookup: a work the user searched for may
 * well be public domain and available, in which case it becomes a one-click
 * add rather than an upload. Matching on title plus author surname, with the
 * same scorer the seed uses, because title alone returns dozens of unrelated
 * devotional works for something like "Meditations".
 *
 * Idempotent: the generated book id is derived from the Open Library work key,
 * so adopting the same work twice returns the existing row.
 */
async function adoptOpenLibraryWork(prefixedId: string): Promise<string> {
  const workKey = prefixedId.slice('ol:'.length)
  const localId = `bk_ol_${workKey.replace(/[^a-zA-Z0-9]/g, '').slice(0, 40)}`

  const existing = await db.query.books.findFirst({
    where: (b, { eq: isEq }) => isEq(b.id, localId),
  })
  if (existing) return localId

  const { findWork, coverUrl } = await import('@/lib/sources/openlibrary')
  const { loadCatalog, matchBook } = await import('@/lib/sources/gutenberg')

  // Open Library's search already gave us the work; re-fetch by title+author
  // is not possible from a key alone, so search by the key's own title.
  const work = await fetchWorkByKey(workKey)
  if (!work) throw new NotFoundError(`Open Library work ${workKey} not found`)

  const author = work.authorName ?? 'Unknown'
  const surname = author.split(/\s+/).pop() ?? author

  let gutenbergId: number | null = null
  try {
    const catalog = await loadCatalog()
    const hit = matchBook(catalog, work.title, surname)
    if (hit) gutenbergId = hit.id
  } catch {
    // No Gutenberg catalog (offline, first run) just means we cannot offer the
    // text — the book is still addable with the user's own copy.
  }

  // Refine the metadata now that we know the title/author pair.
  const enriched = (await findWork(work.title, author).catch(() => null)) ?? work

  await db
    .insert(books)
    .values({
      id: localId,
      title: work.title,
      author,
      yearWritten: work.firstPublishYear ? String(work.firstPublishYear) : null,
      category: enriched.subjects[0] ?? null,
      color: null,
      isPd: gutenbergId !== null,
      gutenbergId,
      openlibraryKey: workKey,
      coverUrl: work.coverId ? coverUrl(work.coverId, 'M') : null,
      olData: { subjects: enriched.subjects, editionCount: enriched.editionCount },
      olFetchedAt: new Date(),
    })
    .onConflictDoNothing()

  return localId
}

/** Open Library serves a work document at /works/OL…W.json. */
async function fetchWorkByKey(workKey: string): Promise<{
  title: string
  authorName: string | null
  firstPublishYear: number | null
  coverId: number | null
  subjects: string[]
  editionCount: number
} | null> {
  const res = await fetch(`https://openlibrary.org${workKey}.json`, {
    headers: { Accept: 'application/json', 'User-Agent': 'LibrarianAI/0.1 (self-hosted)' },
    redirect: 'follow',
  })
  if (!res.ok) return null
  const doc = (await res.json()) as {
    title?: string
    covers?: number[]
    subjects?: string[]
    first_publish_date?: string
    authors?: { author?: { key?: string } }[]
  }
  if (!doc.title) return null

  // The work document references authors by key; one extra fetch for a name.
  let authorName: string | null = null
  const authorKey = doc.authors?.[0]?.author?.key
  if (authorKey) {
    const a = await fetch(`https://openlibrary.org${authorKey}.json`, {
      headers: { Accept: 'application/json', 'User-Agent': 'LibrarianAI/0.1 (self-hosted)' },
    }).catch(() => null)
    if (a?.ok) authorName = ((await a.json()) as { name?: string }).name ?? null
  }

  const year = doc.first_publish_date?.match(/\d{4}/)?.[0]
  return {
    title: doc.title,
    authorName,
    firstPublishYear: year ? Number(year) : null,
    coverId: doc.covers?.[0] ?? null,
    subjects: (doc.subjects ?? []).slice(0, 12),
    editionCount: 0,
  }
}

/**
 * Remove a book from a user's library.
 *
 * Private editions are destroyed completely — vectors, chunks, stored text,
 * the uploaded file and the row. Public editions are KEPT: they are shared,
 * they cost nothing per user, and discarding the indexing work would punish
 * the next person to add the same book.
 *
 * Who does the erasing depends on whether the worker is holding the edition.
 * It is the only writer of these vectors, so deleting underneath it would race
 * its next upsert and strand points that no row could attribute or remove.
 * While it is parsing or embedding, this marks a 'deleting' tombstone instead
 * and the worker purges at its next batch boundary — a second or two later,
 * and complete. Removal is therefore also how indexing is stopped.
 */
export async function removeBook(userId: string, editionId: string): Promise<void> {
  const edition = await db.query.editions.findFirst({
    where: (e, { eq: isEq }) => isEq(e.id, editionId),
  })

  await db
    .delete(userLibrary)
    .where(and(eq(userLibrary.userId, userId), eq(userLibrary.editionId, editionId)))

  if (!edition || edition.kind !== 'private') return
  // Ownership re-checked rather than trusted: the editionId arrived over HTTP.
  if (edition.ownerUserId !== userId) return

  if (edition.indexStatus === 'parsing' || edition.indexStatus === 'embedding') {
    await db
      .update(editions)
      .set({ indexStatus: 'deleting', error: null })
      .where(eq(editions.id, editionId))
    return
  }

  await purgeEdition(editionId)
}

export async function setSelected(
  userId: string,
  editionId: string,
  selected: boolean,
): Promise<void> {
  await db
    .update(userLibrary)
    .set({ selected })
    .where(and(eq(userLibrary.userId, userId), eq(userLibrary.editionId, editionId)))
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NotFoundError'
  }
}

/**
 * The library as the model sees it.
 *
 * A book that is still indexing is reported as not-yet-searchable rather than
 * omitted: "that's still being indexed" is a useful answer, and silence about
 * a book the user just added is not.
 */
export async function getLibraryForPrompt(userId: string): Promise<LibraryEntry[]> {
  const rows = await getLibrary(userId)
  return rows.map((r) => ({
    bookId: r.bookId,
    title: r.title,
    author: r.author,
    kind: r.kind,
    edition: r.edition,
    status: r.status === 'ready' && r.indexStatus === 'ready' && r.selected ? 'ready' : 'needs_file',
  }))
}
