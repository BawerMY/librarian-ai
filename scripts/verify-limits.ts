/**
 * The reveal cap test.
 *
 *   pnpm verify:limits
 *
 * This exists because the cap shipped broken: recordReveal() returned a
 * decision and NOTHING read it, so a user could walk an uploaded copyrighted
 * book a few passages at a time, indefinitely. It was described as enforced
 * and was not. A counter nobody checks is not a limit.
 *
 * Uses a synthetic private edition so no real upload is touched.
 */
import { config } from 'dotenv'

config({ path: '.env.local', quiet: true })

const USER = 'test-limits-user'
const BOOK = 'bk_test_limits'
const EDITION = 'ed_pv_test_limits'

let failures = 0
function check(label: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

async function main() {
  const { books, chunks, db, editions, revealLog, userLibrary, users } = await import('@/db')
  const { MAX_REVEAL_FRACTION, capQuote, checkReveal, recordReveal, MAX_QUOTE_CHARS } = await import(
    '@/lib/limits'
  )
  const { inArray } = await import('drizzle-orm')

  await cleanup()

  const CHUNK_COUNT = 100
  await db.insert(users).values({ id: USER, email: `${USER}@test.local`, name: 'Limits' })
  await db.insert(books).values({ id: BOOK, title: 'Test Book', author: 'Nobody', isPd: false })
  await db.insert(editions).values({
    id: EDITION,
    bookId: BOOK,
    kind: 'private',
    ownerUserId: USER,
    indexStatus: 'ready',
    chunkCount: CHUNK_COUNT,
  })
  await db
    .insert(userLibrary)
    .values({ userId: USER, editionId: EDITION, status: 'ready', selected: true })

  try {
    const cap = Math.ceil(CHUNK_COUNT * MAX_REVEAL_FRACTION)
    console.log(`edition has ${CHUNK_COUNT} chunks; cap is ${cap} (${MAX_REVEAL_FRACTION * 100}%)\n`)

    console.log('quote cap')
    const long = 'word '.repeat(400)
    check(
      `a long passage is truncated to <= ${MAX_QUOTE_CHARS} chars`,
      capQuote(long).length <= MAX_QUOTE_CHARS,
      `${capQuote(long).length} chars`,
    )

    console.log('\nreveal cap')
    const fresh = await checkReveal(USER, EDITION)
    check('a fresh edition is allowed', fresh.allowed, `${fresh.seen}/${fresh.cap}`)

    // Reveal right up to, but not past, the cap.
    await recordReveal(USER, EDITION, Array.from({ length: cap - 1 }, (_, i) => i))
    const nearly = await checkReveal(USER, EDITION)
    check('still allowed one short of the cap', nearly.allowed, `${nearly.seen}/${nearly.cap}`)

    await recordReveal(USER, EDITION, [cap - 1])
    const spent = await checkReveal(USER, EDITION)
    check('refused once the cap is reached', !spent.allowed, `${spent.seen}/${spent.cap}`)

    console.log('\nidempotence')
    const before = (await checkReveal(USER, EDITION)).seen
    await recordReveal(USER, EDITION, [0, 1, 2])
    const after = (await checkReveal(USER, EDITION)).seen
    check('re-showing the same chunks costs nothing', before === after, `${before} -> ${after}`)

    console.log('\npublic editions are exempt')
    const publicEdition = await db.query.editions.findFirst({
      where: (e, { and, eq }) => and(eq(e.kind, 'public'), eq(e.indexStatus, 'ready')),
    })
    if (!publicEdition) {
      console.log('  SKIP  no indexed public edition to check')
    } else {
      const pub = await checkReveal(USER, publicEdition.id)
      check('public-domain text has no cap', pub.allowed && pub.cap === Number.POSITIVE_INFINITY)
    }
  } finally {
    await cleanup()
  }

  console.log(failures === 0 ? '\nall limit checks passed' : `\n${failures} CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)

  async function cleanup() {
    await db.delete(revealLog).where(inArray(revealLog.userId, [USER]))
    await db.delete(userLibrary).where(inArray(userLibrary.userId, [USER]))
    await db.delete(chunks).where(inArray(chunks.editionId, [EDITION]))
    await db.delete(editions).where(inArray(editions.id, [EDITION]))
    await db.delete(books).where(inArray(books.id, [BOOK]))
    await db.delete(users).where(inArray(users.id, [USER]))
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
