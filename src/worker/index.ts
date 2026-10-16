/**
 * Ingest worker.
 *
 * A separate process from Next, not a route handler: parsing a 900KB EPUB and
 * embedding 2,000 chunks takes minutes, and it must survive dev reloads and
 * never occupy a request. It claims work by polling
 * `editions.index_status = 'pending'` — no queue service, no inbound
 * connection, and a crash mid-book is repaired by the next tick because
 * indexEdition() is idempotent.
 *
 *   pnpm worker
 */
import { config } from 'dotenv'

config({ path: '.env.local', quiet: true })

const POLL_MS = 3000
const STALE_MS = 15 * 60 * 1000

let stopping = false

async function main() {
  const { db, editions } = await import('@/db')
  const { CancelledError, indexEdition, purgeEdition } = await import('@/lib/ingest/pipeline')
  const { ensureCollection } = await import('@/lib/qdrant')
  const { env } = await import('@/lib/env')
  const { and, eq, lt, or } = await import('drizzle-orm')

  await ensureCollection()
  console.log(`worker up — ${env.embed.model} (${env.embed.dim}d) -> ${env.qdrant.collection}`)

  // A process killed mid-book leaves rows stuck in 'parsing'/'embedding'
  // forever. Reclaim them on boot rather than requiring manual repair.
  const reclaimed = await db
    .update(editions)
    .set({ indexStatus: 'pending', progress: 0 })
    .where(
      and(
        or(eq(editions.indexStatus, 'parsing'), eq(editions.indexStatus, 'embedding')),
        lt(editions.createdAt, new Date(Date.now() - STALE_MS)),
      ),
    )
    .returning({ id: editions.id })

  if (reclaimed.length) console.log(`reclaimed ${reclaimed.length} stalled edition(s)`)

  /**
   * Finish deletions nobody finished.
   *
   * removeBook tombstones an edition the worker is holding and leaves the
   * erasing to it. If that worker died first — or was not running at all —
   * the row would sit in 'deleting' with its vectors and file intact, which
   * is precisely the state the tombstone exists to prevent. Swept at boot and
   * between books, so the longest a removed book survives is one book.
   */
  async function sweepDeleted(): Promise<void> {
    const doomed = await db
      .select({ id: editions.id })
      .from(editions)
      .where(eq(editions.indexStatus, 'deleting'))

    for (const { id } of doomed) {
      await purgeEdition(id)
      console.log(`purged ${id} (removed while indexing)`)
    }
  }

  await sweepDeleted()

  while (!stopping) {
    await sweepDeleted()

    const next = await db.query.editions.findFirst({
      where: (e, { eq: isEq }) => isEq(e.indexStatus, 'pending'),
      orderBy: (e, { asc }) => asc(e.createdAt),
    })

    if (!next) {
      await sleep(POLL_MS)
      continue
    }

    // Claim it before doing the work, so a second worker cannot pick it up.
    const claimed = await db
      .update(editions)
      .set({ indexStatus: 'parsing' })
      .where(and(eq(editions.id, next.id), eq(editions.indexStatus, 'pending')))
      .returning({ id: editions.id })

    if (!claimed.length) continue

    const label = `${next.kind} ${next.bookId} (${next.id})`
    console.log(`indexing ${label}…`)
    const started = Date.now()

    try {
      const { chunkCount } = await indexEdition(next.id)
      const secs = ((Date.now() - started) / 1000).toFixed(1)
      console.log(`  ok — ${chunkCount} chunks in ${secs}s`)
    } catch (err) {
      // A book the owner deleted mid-run is not a failure, and indexEdition
      // has already purged it — say so plainly instead of logging an error
      // for a row that no longer exists.
      if (err instanceof CancelledError) {
        console.log('  removed during indexing — purged')
        continue
      }
      // indexEdition already recorded 'failed' + the message on the row;
      // the Processing screen surfaces it. Keep the loop alive.
      console.error(`  failed — ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (stopping) process.exit(1)
    stopping = true
    console.log('\nstopping after current book…')
  })
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
