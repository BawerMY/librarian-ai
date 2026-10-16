import { createHash } from 'node:crypto'
import { readFile, unlink } from 'node:fs/promises'
import { eq } from 'drizzle-orm'

import { chunks as chunksTable, db, editionText, editions, userLibrary } from '@/db'
import { BATCH_SIZE, embed } from '@/lib/embed/ollama'
import { env } from '@/lib/env'
import { COLLECTION, pointId, qdrant, type ChunkPayload } from '@/lib/qdrant'
import { assertPublicDomain, download, epubUrl } from '@/lib/sources/gutenberg'

import { chunkBook, type Chunk } from './chunk'
import { parseEpub } from './epub'
import { stripGutenbergBoilerplate, type ParsedBook } from './types'

/**
 * parse -> chunk -> embed -> index, for one edition.
 *
 * Ordering rule that must not be broken: the Postgres chunk row is the commit,
 * the Qdrant upsert is the index update. Postgres is written first, always. If
 * Qdrant ever runs ahead, there are vectors nothing can explain, attribute or
 * delete — and the "drop the collection and rebuild" escape hatch stops being
 * true, which is what keeps every chunking and model decision reversible.
 *
 * Idempotent: deterministic point ids plus a delete-then-insert of chunk rows
 * mean an interrupted run is fixed by running it again.
 */

// Matches the embedder's own batch size so one slice is one Ollama call —
// this loop additionally controls how often progress is written.
const EMBED_BATCH = BATCH_SIZE

export type IndexResult = {
  editionId: string
  chunkCount: number
  skipped?: 'already-indexed'
}

export async function indexEdition(editionId: string): Promise<IndexResult> {
  const edition = await db.query.editions.findFirst({
    where: (e, { eq: isEq }) => isEq(e.id, editionId),
  })
  if (!edition) throw new Error(`Edition not found: ${editionId}`)

  try {
    await setStatus(editionId, 'parsing', 0)

    const { book, rawPath } = await loadSource(edition)

    const hash = createHash('sha256').update(book.text).digest('hex')
    const chunked = chunkBook(book)
    if (!chunked.length) throw new Error('Parsed book produced zero chunks')

    await setStatus(editionId, 'embedding', 5)

    // Keep the normalized full text for PUBLIC editions only. It makes
    // re-chunking cheap (change chunk size, fix a parser bug) without
    // re-fetching. For private editions it would be a second complete
    // verbatim copy of a copyrighted work whose only purpose is our
    // convenience, so it is dropped — re-chunking those needs a re-upload.
    if (edition.kind === 'public') {
      await db
        .insert(editionText)
        .values({ editionId, text: book.text, structure: book.structure })
        .onConflictDoUpdate({
          target: editionText.editionId,
          set: { text: book.text, structure: book.structure },
        })
    } else {
      await db.delete(editionText).where(eq(editionText.editionId, editionId))
    }

    // Replace rather than merge: a re-index with different chunk settings
    // produces a different number of chunks, and stale high-idx rows would
    // otherwise survive as orphans pointing at vectors that no longer exist.
    await removeIndex(editionId)

    await db.insert(chunksTable).values(
      chunked.map((c) => ({
        id: `${editionId}:${c.idx}`,
        editionId,
        idx: c.idx,
        text: c.text,
        chapter: c.chapter,
        section: c.section,
        page: c.page,
        posPct: c.posPct,
        lang: 'en',
        tokenCount: c.tokenCount,
      })),
    )

    await embedAndUpsert(edition, chunked)

    await db
      .update(editions)
      .set({
        indexStatus: 'ready',
        progress: 100,
        error: null,
        chunkCount: chunked.length,
        contentHash: hash,
        embedModel: env.embed.model,
        embedDim: env.embed.dim,
        hasPages: book.hasPages,
        indexedAt: new Date(),
      })
      .where(eq(editions.id, editionId))

    // Anyone who added this book before it finished indexing becomes
    // searchable now.
    await db
      .update(userLibrary)
      .set({ status: 'ready' })
      .where(eq(userLibrary.editionId, editionId))

    // The uploaded file has served its purpose. Chunks and vectors are what
    // the app actually needs; keeping the distributable artifact around is
    // the part with no upside.
    //
    // source_ref is cleared with it, so the row never claims a path that no
    // longer exists — otherwise a re-index would fail on a missing file and
    // the database would be quietly lying about what is on disk.
    if (rawPath) {
      await unlink(rawPath).catch(() => {})
      await db
        .update(editions)
        .set({ sourceRef: null })
        .where(eq(editions.id, editionId))
    }

    return { editionId, chunkCount: chunked.length }
  } catch (err) {
    // The owner deleted the book mid-run. Finish the deletion they asked for
    // rather than recording a failure against a row that should not survive:
    // this is the only moment at which everything written so far — the partial
    // vectors above all — is still identifiable.
    //
    // Any other error is read the same way if the row is gone or tombstoned:
    // a delete landing between the chunk insert and its edition row surfaces
    // as a foreign-key violation, which is a deletion, not a parse failure.
    if (err instanceof CancelledError || (await cancelled(editionId))) {
      await purgeEdition(editionId)
      throw err instanceof CancelledError ? err : new CancelledError(editionId)
    }

    const message = err instanceof Error ? err.message : String(err)
    await db
      .update(editions)
      .set({ indexStatus: 'failed', error: message.slice(0, 2000) })
      .where(eq(editions.id, editionId))
    throw err
  }
}

/* ------------------------------------------------------------------ */

type EditionRow = typeof editions.$inferSelect

async function loadSource(
  edition: EditionRow,
): Promise<{ book: ParsedBook; rawPath: string | null }> {
  if (edition.kind === 'public') {
    if (edition.source !== 'gutenberg' || !edition.sourceRef) {
      throw new Error(`Public edition ${edition.id} has no gutenberg source_ref`)
    }
    const gid = Number(edition.sourceRef)
    if (!Number.isInteger(gid)) throw new Error(`Bad Gutenberg id: ${edition.sourceRef}`)

    // One request: the URL is derived from the id, so no metadata API sits in
    // the ingest path. The EPUB we download to get the text is also what
    // proves we may host it.
    const bytes = await download(epubUrl(gid))
    const book = await parseEpub(bytes)

    assertPublicDomain(book.meta.rights, `Gutenberg ${gid}`)
    if (book.meta.language && !book.meta.language.toLowerCase().startsWith('en')) {
      throw new Error(
        `Gutenberg ${gid} declares language "${book.meta.language}"; the embedding model is English-only.`,
      )
    }

    return { book, rawPath: null }
  }

  // Private upload: bytes sit on disk under a per-user directory until indexed.
  if (!edition.sourceRef) throw new Error(`Private edition ${edition.id} has no file path`)
  const path = edition.sourceRef
  const bytes = await readFile(path)

  switch (edition.fileFormat) {
    case 'epub':
      return { book: await parseEpub(bytes), rawPath: path }
    case 'txt': {
      const text = stripGutenbergBoilerplate(normalizeText(bytes.toString('utf8')))
      return {
        book: {
          text,
          structure: [{ chapter: null, section: null, start: 0, end: text.length, pageStart: null }],
          meta: {},
          hasPages: false,
        },
        rawPath: path,
      }
    }
    default:
      // PDF arrives in slice 4, where pdfjs-dist gives real page numbers.
      throw new Error(`Unsupported file format: ${edition.fileFormat}`)
  }
}

function normalizeText(s: string): string {
  return s
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

async function embedAndUpsert(edition: EditionRow, chunked: Chunk[]): Promise<void> {
  const visibility = edition.kind === 'public' ? 'public' : 'private'
  const ownerId = edition.kind === 'private' ? edition.ownerUserId : null

  for (let i = 0; i < chunked.length; i += EMBED_BATCH) {
    const batch = chunked.slice(i, i + EMBED_BATCH)
    const vectors = await embed(
      batch.map((c) => c.text),
      'passage',
    )

    const points = await Promise.all(
      batch.map(async (c, j) => ({
        id: await pointId(edition.id, c.idx),
        vector: vectors[j],
        payload: {
          edition_id: edition.id,
          book_id: edition.bookId,
          chunk_idx: c.idx,
          visibility,
          owner_id: ownerId,
          lang: 'en',
          chapter: c.chapter,
          section: c.section,
          page: c.page,
          pos_pct: c.posPct,
          text: c.text,
        } satisfies ChunkPayload,
      })),
    )

    await qdrant.upsert(COLLECTION, { wait: true, points })

    // Between batches, not inside one: an upsert is the only write that can
    // outlive a delete, so checking right after each is what bounds the
    // orphan window to a single batch.
    if (await cancelled(edition.id)) throw new CancelledError(edition.id)

    // 5-100: parsing already claimed the first few percent, and a bar that
    // starts at zero after visible work has happened reads as stalled.
    const done = Math.min(i + batch.length, chunked.length)
    const pct = 5 + Math.round((done / chunked.length) * 95)
    await setStatus(edition.id, 'embedding', pct)
  }
}

/**
 * The owner removed the book while this edition was being indexed.
 *
 * Thrown from inside the embed loop so the run unwinds through indexEdition's
 * own catch, which purges rather than recording a failure — a book the user
 * deleted is not a book that failed.
 */
export class CancelledError extends Error {
  constructor(editionId: string) {
    super(`Indexing cancelled: ${editionId} was removed`)
    this.name = 'CancelledError'
  }
}

/**
 * Erase a private edition completely: vectors, chunk rows, stored text, the
 * uploaded file, and the edition itself.
 *
 * removeIndex() alone was not enough. It drops derived data, but the upload
 * under UPLOAD_DIR is unlinked only on the success path of indexEdition — so
 * removing a book before indexing finished left the user's file on disk with
 * the row that recorded its path deleted, unreachable and permanent.
 *
 * Order matters: the file and the vectors go before the row. The row is what
 * names them, so losing it first would strand both.
 *
 * Idempotent — it is called from the deleter, from the worker's cancellation
 * path, and from the boot sweep, and any of those may have run already.
 */
export async function purgeEdition(editionId: string): Promise<void> {
  const edition = await db.query.editions.findFirst({
    where: (e, { eq: isEq }) => isEq(e.id, editionId),
  })

  if (edition?.sourceRef && edition.kind === 'private') {
    // Gutenberg editions keep an id here, not a path; only uploads have a file.
    await unlink(edition.sourceRef).catch(() => {})
  }

  await removeIndex(editionId)
  await db.delete(editionText).where(eq(editionText.editionId, editionId))
  await db.delete(editions).where(eq(editions.id, editionId))
}

/**
 * Has the owner asked for this edition to go away?
 *
 * Checked between embed batches. The window that remains is one batch wide,
 * and whatever that batch wrote is removed by the purge that follows.
 */
async function cancelled(editionId: string): Promise<boolean> {
  const row = await db.query.editions.findFirst({
    columns: { indexStatus: true },
    where: (e, { eq: isEq }) => isEq(e.id, editionId),
  })
  // A row that vanished outright counts too: an admin delete, or a purge that
  // beat us to it.
  return !row || row.indexStatus === 'deleting'
}

/** Drop an edition's derived data. Postgres rows and vectors together. */
export async function removeIndex(editionId: string): Promise<void> {
  await db.delete(chunksTable).where(eq(chunksTable.editionId, editionId))
  await qdrant.delete(COLLECTION, {
    wait: true,
    filter: { must: [{ key: 'edition_id', match: { value: editionId } }] },
  })
}

async function setStatus(
  editionId: string,
  status: 'pending' | 'parsing' | 'embedding' | 'ready' | 'failed',
  progress: number,
): Promise<void> {
  await db
    .update(editions)
    .set({ indexStatus: status, progress })
    .where(eq(editions.id, editionId))
}
