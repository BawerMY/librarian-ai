import { auth } from '@/auth'
import { books, db } from '@/db'
import { getLibrary } from '@/lib/library'
import { coverUrl, searchWorks } from '@/lib/sources/openlibrary'

/**
 * The Add books screen: one search bar over Open Library.
 *
 * There is deliberately no curated catalog any more. A fixed list of 26 books
 * was a worse product than a search box — it implied those were the books the
 * app was for, and every other title looked unsupported.
 *
 * Metadata only. No text is returned, so nothing here needs per-user scoping;
 * the only user-specific field is `inLibrary`.
 *
 * Whether we can supply the text is NOT known here. It is decided at add time
 * by looking for a Gutenberg match (see adoptOpenLibraryWork in lib/library.ts).
 * Guessing it from the publication year would be wrong often enough to matter,
 * so the UI says "we'll check" rather than promising either path.
 */
export async function GET(req: Request) {
  const session = await auth()
  const uid = session?.user?.id
  if (!uid) return new Response('Unauthorized', { status: 401 })

  const q = (new URL(req.url).searchParams.get('q') ?? '').trim()
  if (q.length < 3) return Response.json({ books: [], query: q })

  // Which Open Library works this user already holds, so results can be
  // marked rather than offered twice.
  const mine = await getLibrary(uid)
  const ownedBookIds = new Set(mine.map((b) => b.bookId))
  const ownedKeys = new Set(
    (
      await db
        .select({ id: books.id, olKey: books.openlibraryKey })
        .from(books)
    )
      .filter((b) => ownedBookIds.has(b.id) && b.olKey)
      .map((b) => b.olKey as string),
  )

  try {
    const works = await searchWorks(q, 20)
    return Response.json({
      query: q,
      books: works.map((w) => ({
        id: `ol:${w.key}`,
        title: w.title,
        author: w.authorName ?? 'Unknown',
        yearWritten: w.firstPublishYear ? String(w.firstPublishYear) : null,
        coverUrl: w.coverId ? coverUrl(w.coverId, 'M') : null,
        editionCount: w.editionCount,
        inLibrary: ownedKeys.has(w.key),
      })),
    })
  } catch (err) {
    return Response.json(
      {
        query: q,
        books: [],
        error:
          err instanceof Error
            ? `Open Library did not respond (${err.message}).`
            : 'Open Library did not respond.',
      },
      { status: 502 },
    )
  }
}
