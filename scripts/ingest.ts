/**
 * Create and index a PUBLIC edition from Project Gutenberg.
 *
 *   pnpm ingest 2680                     # by Gutenberg id
 *   pnpm ingest 2680 --now               # index inline instead of queueing
 *   pnpm ingest --find "wealth of nations" --author smith
 *
 * Public editions are text we host and serve to every user, so `--find` only
 * reports candidates; creating one always takes an explicit id. Attaching the
 * wrong Gutenberg text to a catalog entry would give a book whose every
 * citation points at another author's words, and nothing downstream would
 * notice.
 */
import { config } from 'dotenv'

config({ path: '.env.local', quiet: true })

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48)
}

/** "Marcus Aurelius, Emperor of Rome, 121-180" -> "Marcus Aurelius" */
function displayAuthor(authors: string): string {
  const first = authors.split(';')[0]?.trim() ?? 'Unknown'
  const noDates = first.replace(/,\s*\d{3,4}(-\d{0,4})?\s*$/, '').trim()
  const parts = noDates.split(',').map((p) => p.trim())
  if (parts.length >= 2 && /^[A-Z]/.test(parts[1])) return `${parts[1]} ${parts[0]}`
  return noDates
}

function surname(authors: string): string {
  return (authors.split(';')[0]?.split(',')[0] ?? '').trim()
}

async function main() {
  const { loadCatalog, matchBook } = await import('@/lib/sources/gutenberg')

  const find = arg('find')
  if (find) {
    const catalog = await loadCatalog()
    console.log(`catalog: ${catalog.length.toLocaleString()} English texts`)
    const author = arg('author') ?? ''
    const hit = matchBook(catalog, find, author)
    if (hit) {
      console.log(`\nbest match`)
      console.log(`  id       ${hit.id}`)
      console.log(`  title    ${hit.title}`)
      console.log(`  authors  ${hit.authors}`)
      console.log(`  subjects ${hit.subjects.slice(0, 4).join('; ')}`)
      console.log(`\n  pnpm ingest ${hit.id} --now`)
    } else {
      console.log(`\nno match for "${find}"${author ? ` by ${author}` : ''}`)
    }
    process.exit(0)
  }

  const raw = process.argv[2]?.replace(/^gutenberg:/, '')
  const gid = Number(raw)
  if (!Number.isInteger(gid)) {
    console.error('usage: pnpm ingest <gutenberg-id> [--now]')
    console.error('       pnpm ingest --find "<title>" [--author <surname>]')
    process.exit(1)
  }

  const { db, books, editions } = await import('@/db')
  const { indexEdition } = await import('@/lib/ingest/pipeline')
  const { eq } = await import('drizzle-orm')

  const catalog = await loadCatalog()
  const entry = catalog.find((e) => e.id === gid)
  if (!entry) {
    throw new Error(
      `Gutenberg ${gid} is not an English text in the catalog. ` +
        `The embedding model is English-only, so it cannot become a public edition.`,
    )
  }

  const author = displayAuthor(entry.authors)
  const bookId = `bk_${slug(`${surname(entry.authors)} ${entry.title}`)}`
  const editionId = `ed_pd_${gid}`

  await db
    .insert(books)
    .values({
      id: bookId,
      title: entry.title,
      author,
      category: entry.subjects[0] ?? null,
      isPd: true,
    })
    .onConflictDoNothing()

  const existing = await db.query.editions.findFirst({
    where: (e, { eq: isEq }) => isEq(e.id, editionId),
  })

  if (existing) {
    console.log(`edition ${editionId} exists (${existing.indexStatus}) — re-queueing`)
    await db
      .update(editions)
      .set({ indexStatus: 'pending', progress: 0, error: null, source: 'gutenberg' })
      .where(eq(editions.id, editionId))
  } else {
    await db.insert(editions).values({
      id: editionId,
      bookId,
      kind: 'public',
      lang: 'en',
      source: 'gutenberg',
      sourceRef: String(gid),
      fileFormat: 'epub',
      indexStatus: 'pending',
    })
    console.log(`queued ${editionId} — ${entry.title} (${author})`)
  }

  if (process.argv.includes('--now')) {
    console.log('indexing inline…')
    const started = Date.now()
    // Rights are verified inside the pipeline, from the EPUB's own dc:rights.
    const { chunkCount } = await indexEdition(editionId)
    console.log(`done — ${chunkCount} chunks in ${((Date.now() - started) / 1000).toFixed(1)}s`)
  } else {
    console.log('run `pnpm worker` to index it.')
  }

  process.exit(0)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
