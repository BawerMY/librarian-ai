/**
 * Postgres <-> Qdrant consistency check.
 *
 *   pnpm verify:index
 *   pnpm verify:index --fix
 *
 * Postgres is the source of truth and Qdrant is a derived index. That claim is
 * only worth anything if it is checked: drift is silent, because a stale
 * payload still returns plausible search results.
 *
 * Checks, per edition:
 *   - chunk rows vs indexed points (a mismatch means a half-finished index)
 *   - payload book_id vs editions.book_id
 *   - payload owner_id / visibility vs the edition's kind and owner
 *
 * The book_id check caught a real bug: `pnpm seed` repointed editions onto
 * curated book ids in Postgres but left the Qdrant payloads asserting the old
 * generated ids, so everything keyed on book_id — bookInfo, catalog exclusion,
 * the "View in library" link — silently missed.
 *
 * --fix repairs payload fields in place with setPayload (no re-embedding).
 * A chunk-count mismatch is NOT auto-fixable; it needs `pnpm reindex`.
 */
import { config } from 'dotenv'

config({ path: '.env.local', quiet: true })

let problems = 0
let fixed = 0

async function main() {
  const fix = process.argv.includes('--fix')

  const { chunks, db, editions } = await import('@/db')
  const { COLLECTION, qdrant } = await import('@/lib/qdrant')
  const { count, eq } = await import('drizzle-orm')

  const all = await db.query.editions.findMany()
  if (!all.length) {
    console.log('no editions')
    process.exit(0)
  }

  console.log(`${'edition'.padEnd(14)} ${'rows'.padStart(6)} ${'points'.padStart(7)}  status`)

  // Rows and points only have to agree once indexing has finished. Flagging an
  // edition mid-embed as corruption would make this check cry wolf, and a
  // consistency check nobody trusts is worse than none.
  const inFlight = all.filter((e) => e.indexStatus === 'parsing' || e.indexStatus === 'embedding')
  let inFlightRows = 0
  let inFlightPoints = 0

  for (const e of all) {
    const [{ value: rowCount }] = await db
      .select({ value: count() })
      .from(chunks)
      .where(eq(chunks.editionId, e.id))

    const filter = { must: [{ key: 'edition_id', match: { value: e.id } }] }
    const { count: pointCount } = await qdrant.count(COLLECTION, { filter, exact: true })

    const notes: string[] = []
    const indexing = e.indexStatus === 'parsing' || e.indexStatus === 'embedding'

    if (indexing) {
      inFlightRows += rowCount
      inFlightPoints += pointCount
      notes.push(`indexing (${e.progress}%) — counts not expected to match yet`)
    } else if (rowCount !== pointCount) {
      notes.push(`COUNT MISMATCH (run: pnpm reindex --edition ${e.id})`)
      problems++
    }

    if (pointCount > 0) {
      const sample = await qdrant.scroll(COLLECTION, {
        filter,
        limit: 1,
        with_payload: ['book_id', 'owner_id', 'visibility'],
        with_vector: false,
      })
      const p = sample.points[0]?.payload as
        | { book_id?: string; owner_id?: string | null; visibility?: string }
        | undefined

      const wantVisibility = e.kind === 'public' ? 'public' : 'private'
      const wantOwner = e.kind === 'private' ? e.ownerUserId : null

      const repair: Record<string, unknown> = {}
      if (p && p.book_id !== e.bookId) {
        notes.push(`book_id "${p.book_id}" != "${e.bookId}"`)
        repair.book_id = e.bookId
      }
      if (p && p.visibility !== wantVisibility) {
        notes.push(`visibility "${p.visibility}" != "${wantVisibility}"`)
        repair.visibility = wantVisibility
      }
      if (p && (p.owner_id ?? null) !== wantOwner) {
        notes.push(`owner_id "${p.owner_id}" != "${wantOwner}"`)
        repair.owner_id = wantOwner
      }

      if (Object.keys(repair).length) {
        problems++
        if (fix) {
          await qdrant.setPayload(COLLECTION, { wait: true, payload: repair, filter })
          notes.push('→ FIXED')
          fixed++
        }
      }
    }

    console.log(
      `${e.id.padEnd(14)} ${String(rowCount).padStart(6)} ${String(pointCount).padStart(7)}  ` +
        (notes.length ? notes.join('; ') : 'ok'),
    )
  }

  // Points whose edition no longer exists at all — the shape that appears if
  // Qdrant is ever written before Postgres.
  const info = await qdrant.getCollection(COLLECTION)
  const totalPoints = info.points_count ?? 0
  const [{ value: totalRows }] = await db.select({ value: count() }).from(chunks)

  // Exclude whatever is still being written, for the same reason.
  const settledRows = totalRows - inFlightRows
  const settledPoints = totalPoints - inFlightPoints

  console.log(`\ntotal   rows ${totalRows}   points ${totalPoints}`)
  if (inFlight.length) {
    console.log(
      `        ${inFlight.length} edition(s) still indexing — excluded from the totals check`,
    )
  }
  if (settledRows !== settledPoints) {
    console.log('ORPHANS: the collection holds points no chunk row explains.')
    console.log('Rebuild from the source of truth: pnpm reindex --all --drop')
    problems++
  }

  if (problems === 0) console.log('\nindex consistent with Postgres')
  else if (fix) console.log(`\n${fixed} repaired, ${problems - fixed} still need attention`)
  else console.log(`\n${problems} problem(s). Re-run with --fix to repair payload fields.`)

  process.exit(problems > fixed ? 1 : 0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
