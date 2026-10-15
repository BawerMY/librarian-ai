/**
 * Rebuild Qdrant from Postgres. The escape hatch.
 *
 *   pnpm reindex --edition ed_pd_45109
 *   pnpm reindex --all
 *   pnpm reindex --all --drop        # recreate the collection first
 *
 * Re-embeds from the `chunks` table — no re-download, no re-parsing, and
 * crucially no asking users to re-upload private books. This is the property
 * that makes today's decisions reversible: swap the embedding model, change
 * chunk size, fix a parser bug, or recover a corrupted index, all without
 * touching the source material.
 *
 * If this script ever stops working, Postgres is no longer the source of
 * truth and every model and chunking choice has quietly become permanent.
 */
import { config } from 'dotenv'

config({ path: '.env.local', quiet: true })

const BATCH = 64

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}

async function main() {
  const { chunks, db, editions } = await import('@/db')
  const { embed } = await import('@/lib/embed/ollama')
  const { env } = await import('@/lib/env')
  const { COLLECTION, ensureCollection, pointId, qdrant } = await import('@/lib/qdrant')
  const { asc, eq } = await import('drizzle-orm')

  const one = arg('edition')
  const all = process.argv.includes('--all')
  if (!one && !all) {
    console.error('usage: pnpm reindex (--edition <id> | --all) [--drop]')
    process.exit(1)
  }

  if (process.argv.includes('--drop')) {
    if (!all) {
      console.error('--drop only makes sense with --all')
      process.exit(1)
    }
    console.log(`dropping collection ${COLLECTION}…`)
    await qdrant.deleteCollection(COLLECTION)
  }
  await ensureCollection()

  const targets = one
    ? await db.query.editions.findMany({ where: (e, { eq: isEq }) => isEq(e.id, one) })
    : await db.query.editions.findMany({
        where: (e, { eq: isEq }) => isEq(e.indexStatus, 'ready'),
      })

  if (!targets.length) {
    console.log('nothing to reindex')
    process.exit(0)
  }

  let totalPoints = 0
  const started = Date.now()

  for (const edition of targets) {
    const rows = await db
      .select()
      .from(chunks)
      .where(eq(chunks.editionId, edition.id))
      .orderBy(asc(chunks.idx))

    if (!rows.length) {
      console.log(`${edition.id}: no chunk rows — re-run ingest, not reindex`)
      continue
    }

    process.stdout.write(`${edition.id}: ${rows.length} chunks `)

    // Clear this edition's points first so a changed chunk count cannot leave
    // orphans behind at the old high indices.
    await qdrant.delete(COLLECTION, {
      wait: true,
      filter: { must: [{ key: 'edition_id', match: { value: edition.id } }] },
    })

    const visibility = edition.kind === 'public' ? 'public' : 'private'
    const ownerId = edition.kind === 'private' ? edition.ownerUserId : null

    for (let i = 0; i < rows.length; i += BATCH) {
      const batch = rows.slice(i, i + BATCH)
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
            lang: c.lang,
            chapter: c.chapter,
            section: c.section,
            page: c.page,
            pos_pct: c.posPct,
            text: c.text,
          },
        })),
      )
      await qdrant.upsert(COLLECTION, { wait: true, points })
      process.stdout.write('.')
    }

    // Record which model these vectors came from, so a half-finished
    // migration is visible rather than guessed at.
    await db
      .update(editions)
      .set({ embedModel: env.embed.model, embedDim: env.embed.dim, indexedAt: new Date() })
      .where(eq(editions.id, edition.id))

    totalPoints += rows.length
    console.log(' ok')
  }

  const info = await qdrant.getCollection(COLLECTION)
  console.log(
    `\nreindexed ${totalPoints} points in ${((Date.now() - started) / 1000).toFixed(1)}s`,
  )
  console.log(`collection now holds ${info.points_count ?? 0} points`)
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
