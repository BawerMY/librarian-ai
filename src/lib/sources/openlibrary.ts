/**
 * Open Library — metadata and covers.
 *
 * Deliberately separate from the Gutenberg module, which supplies TEXT.
 * Gutenberg's own metadata is inconsistent ("Emperor of Rome Marcus Aurelius",
 * Library-of-Congress subject headings), so display data comes from here while
 * the words come from there.
 *
 * Covers are HOTLINKED from Open Library's CDN rather than copied into local
 * storage. Cover art is copyrighted even when the book inside is public
 * domain, so not holding a copy is both less storage and one less thing to
 * justify.
 *
 * Open Library asks for a descriptive User-Agent and rate-limits anonymous
 * traffic, so results are cached into books.ol_data and this is only called
 * when seeding or when that cache is stale.
 */

const SEARCH_URL = 'https://openlibrary.org/search.json'
const USER_AGENT = 'LibrarianAI/0.1 (self-hosted personal library; contact via app owner)'

export type OpenLibraryWork = {
  /** "/works/OL12345W" */
  key: string
  title: string
  authorName: string | null
  firstPublishYear: number | null
  /** Numeric cover id, for the covers CDN. */
  coverId: number | null
  subjects: string[]
  editionCount: number
}

type SearchResponse = {
  numFound: number
  docs: {
    key: string
    title: string
    author_name?: string[]
    first_publish_year?: number
    cover_i?: number
    subject?: string[]
    edition_count?: number
  }[]
}

export function coverUrl(coverId: number, size: 'S' | 'M' | 'L' = 'M'): string {
  return `https://covers.openlibrary.org/b/id/${coverId}-${size}.jpg`
}

/**
 * Best work match for a title + author.
 *
 * Author is required, not optional: searching "Meditations" alone returns
 * dozens of unrelated devotional works, and a wrong match would attach the
 * wrong cover and year to a book whose text is correct — subtly wrong data
 * that nothing downstream would flag.
 */
export async function findWork(title: string, author: string): Promise<OpenLibraryWork | null> {
  const params = new URLSearchParams({
    title,
    author,
    fields: 'key,title,author_name,first_publish_year,cover_i,subject,edition_count',
    limit: '5',
  })

  const data = await get<SearchResponse>(`${SEARCH_URL}?${params}`)
  if (!data.docs?.length) return null

  // Prefer the work with the most editions — a proxy for "the canonical one"
  // that reliably separates the real book from derivative study guides.
  const best = [...data.docs].sort((a, b) => (b.edition_count ?? 0) - (a.edition_count ?? 0))[0]

  return {
    key: best.key,
    title: best.title,
    authorName: best.author_name?.[0] ?? null,
    firstPublishYear: best.first_publish_year ?? null,
    coverId: best.cover_i ?? null,
    subjects: (best.subject ?? []).slice(0, 12),
    editionCount: best.edition_count ?? 0,
  }
}

/**
 * Free-text search over Open Library, for finding books the local catalog has
 * never heard of.
 *
 * This is what makes the Add screen useful beyond the seeded 26: the user can
 * search any title or author, and whether we can supply the text is decided
 * afterwards by looking for a Gutenberg match.
 */
export async function searchWorks(query: string, limit = 12): Promise<OpenLibraryWork[]> {
  const q = query.trim()
  if (q.length < 3) return []

  const params = new URLSearchParams({
    q,
    fields: 'key,title,author_name,first_publish_year,cover_i,subject,edition_count',
    limit: String(Math.min(limit * 2, 40)),
  })

  const data = await get<SearchResponse>(`${SEARCH_URL}?${params}`)
  if (!data.docs?.length) return []

  return (
    data.docs
      // Edition count is the most reliable signal that a row is the real book
      // rather than a study guide, abridgement or library artefact.
      .filter((d) => d.title && (d.edition_count ?? 0) >= 2)
      .sort((a, b) => (b.edition_count ?? 0) - (a.edition_count ?? 0))
      .slice(0, limit)
      .map((d) => ({
        key: d.key,
        title: d.title,
        authorName: d.author_name?.[0] ?? null,
        firstPublishYear: d.first_publish_year ?? null,
        coverId: d.cover_i ?? null,
        subjects: (d.subject ?? []).slice(0, 12),
        editionCount: d.edition_count ?? 0,
      }))
  )
}

async function get<T>(url: string): Promise<T> {
  let lastErr: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
      })
      if (res.status >= 500 || res.status === 429) {
        lastErr = new Error(`Open Library HTTP ${res.status}`)
      } else if (!res.ok) {
        throw new Error(`Open Library HTTP ${res.status}`)
      } else {
        return (await res.json()) as T
      }
    } catch (err) {
      lastErr = err
    }
    await sleep(600 * 2 ** attempt)
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
