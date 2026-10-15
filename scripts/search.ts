/**
 * CLI retrieval check — the fastest way to tell whether citations will be
 * trustworthy before any UI exists.
 *
 *   pnpm search "worrying is worse than the thing itself"
 *   pnpm search "..." --user <userId>    # exercise the real scoped path
 *
 * Without --user it queries the public catalog directly (no per-user scope),
 * which is the right check while the catalog is being built. WITH --user it
 * goes through searchBooks(), i.e. the actual authz boundary.
 */
import { config } from 'dotenv'

config({ path: '.env.local', quiet: true })

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}

async function main() {
  const query = process.argv[2]
  if (!query) {
    console.error('usage: pnpm search "<question>" [--user <userId>] [--limit 8]')
    process.exit(1)
  }
  const limit = Number(arg('limit') ?? 8)
  const userId = arg('user')

  if (userId) {
    const { searchBooks } = await import('@/lib/retrieval/search')
    const { passages, note } = await searchBooks({ userId, query, limit })
    if (note) console.log(`note: ${note}`)
    for (const p of passages) {
      const loc = [p.chapter, p.section].filter(Boolean).join(' · ')
      const where = p.page !== null ? `p. ${p.page}` : `${Math.round(p.posPct * 100)}%`
      console.log(`\n[${p.id}] ${p.score}  ${p.book} — ${loc || '—'} · ${where}`)
      console.log(`     ${p.edition}`)
      console.log(`     ${p.text.slice(0, 260).replace(/\s+/g, ' ')}…`)
    }
    process.exit(0)
  }

  // Unscoped public-catalog path.
  const { embedOne } = await import('@/lib/embed/ollama')
  const { COLLECTION, qdrant } = await import('@/lib/qdrant')
  const { db } = await import('@/db')

  const vector = await embedOne(query, 'query')
  const res = await qdrant.query(COLLECTION, {
    query: vector,
    filter: { must: [{ key: 'visibility', match: { value: 'public' } }] },
    limit,
    with_payload: true,
  })

  const points = res.points ?? []
  if (!points.length) {
    console.log('no results — is anything indexed? (pnpm ingest 2680 --now)')
    process.exit(0)
  }

  const titles = new Map<string, string>()
  for (const row of await db.query.books.findMany({ columns: { id: true, title: true } })) {
    titles.set(row.id, row.title)
  }

  for (const h of points) {
    const p = h.payload as Record<string, any>
    const loc = [p.chapter, p.section].filter(Boolean).join(' · ')
    const where = p.page !== null && p.page !== undefined ? `p. ${p.page}` : `${Math.round(p.pos_pct * 100)}%`
    console.log(
      `\n${h.score.toFixed(3)}  ${titles.get(p.book_id) ?? p.book_id} — ${loc || '—'} · ${where}  [#${p.chunk_idx}]`,
    )
    console.log(`     ${String(p.text).slice(0, 260).replace(/\s+/g, ' ')}…`)
  }

  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
