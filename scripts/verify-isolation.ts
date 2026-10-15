/**
 * The privacy boundary test.
 *
 *   pnpm verify:isolation
 *
 * Builds two users with different libraries and asserts that each one's
 * searches can only reach their own editions. This is the single most
 * important check in the project: every private book in the system lives in
 * one Qdrant collection, and the only thing separating them is that search
 * filters are built from Postgres rather than from input.
 *
 * Creates real rows, then removes them. Safe to re-run.
 */
import { config } from 'dotenv'

config({ path: '.env.local', quiet: true })

const A = 'test-isolation-user-a'
const B = 'test-isolation-user-b'

let failures = 0

function check(label: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

async function main() {
  const { db, editions, userLibrary, users } = await import('@/db')
  const { allowedEditions, narrowToBook } = await import('@/lib/retrieval/scope')
  const { searchBooks } = await import('@/lib/retrieval/search')
  const { and, eq, inArray } = await import('drizzle-orm')

  // PUBLIC editions only. Granting a user a private edition owned by someone
  // else is not a state the app can produce, and using one here would trip the
  // ownership assertion before any of the scope checks ran. That case is
  // tested deliberately further down instead.
  const ready = await db.query.editions.findMany({
    where: (e, { and: all, eq: isEq }) => all(isEq(e.indexStatus, 'ready'), isEq(e.kind, 'public')),
  })
  if (ready.length < 2) {
    console.error(
      `Need at least 2 indexed PUBLIC editions, found ${ready.length}. ` +
        `Run: pnpm ingest 2680 --now && pnpm ingest 45109 --now`,
    )
    process.exit(1)
  }

  const [edA, edB] = ready
  console.log(`user A gets ${edA.id}`)
  console.log(`user B gets ${edB.id}\n`)

  await cleanup()

  await db.insert(users).values([
    { id: A, email: `${A}@test.local`, name: 'A' },
    { id: B, email: `${B}@test.local`, name: 'B' },
  ])
  await db.insert(userLibrary).values([
    { userId: A, editionId: edA.id, status: 'ready', selected: true },
    { userId: B, editionId: edB.id, status: 'ready', selected: true },
  ])

  try {
    /* ---- scope derivation ---- */
    console.log('scope')
    const scopeA = await allowedEditions(A)
    const scopeB = await allowedEditions(B)
    check('A sees exactly 1 edition', scopeA.length === 1, `got ${scopeA.length}`)
    check('B sees exactly 1 edition', scopeB.length === 1, `got ${scopeB.length}`)
    check("A's edition is A's", scopeA[0]?.editionId === edA.id)
    check("B's edition is B's", scopeB[0]?.editionId === edB.id)
    check(
      'scopes are disjoint',
      !scopeA.some((e) => scopeB.some((f) => f.editionId === e.editionId)),
    )

    /* ---- retrieval cannot cross ---- */
    console.log('\nretrieval')
    const resA = await searchBooks({ userId: A, query: 'the nature of virtue and labour', limit: 10 })
    const resB = await searchBooks({ userId: B, query: 'the nature of virtue and labour', limit: 10 })

    check('A got results', resA.passages.length > 0, resA.note ?? '')
    check(
      'every A passage is from A’s edition',
      resA.passages.every((p) => p.editionId === edA.id),
      [...new Set(resA.passages.map((p) => p.editionId))].join(','),
    )
    check(
      'every B passage is from B’s edition',
      resB.passages.every((p) => p.editionId === edB.id),
      [...new Set(resB.passages.map((p) => p.editionId))].join(','),
    )
    check(
      'A never sees B’s edition',
      !resA.passages.some((p) => p.editionId === edB.id),
    )

    /* ---- narrowing cannot widen ---- */
    console.log('\nnarrowing (the bookId parameter the model controls)')
    const asksForBsBook = await searchBooks({
      userId: A,
      query: 'division of labour',
      bookId: edB.bookId,
      limit: 10,
    })
    // NOT "returns nothing": an unmatched bookId deliberately falls back to
    // the user's own books, because returning nothing made the model announce
    // that a book the user owned was missing. The security property is
    // narrower and unchanged — the fallback is still an intersection with
    // what Postgres granted, so B's content must never appear.
    check(
      'A asking for B’s bookId never receives B’s content',
      !asksForBsBook.passages.some((p) => p.editionId === edB.id),
      [...new Set(asksForBsBook.passages.map((p) => p.editionId))].join(',') || 'no passages',
    )
    check(
      'and the ignored bookId is reported rather than hidden',
      Boolean(asksForBsBook.note),
      asksForBsBook.note ?? 'no note',
    )
    check(
      'narrowToBook intersects rather than replaces',
      narrowToBook(scopeA, edB.bookId).length === 0,
    )

    /* ---- unselecting removes from scope ---- */
    console.log('\nselection')
    await db
      .update(userLibrary)
      .set({ selected: false })
      .where(eq(userLibrary.userId, A))
    const afterUnselect = await searchBooks({ userId: A, query: 'virtue', limit: 5 })
    check(
      'deselected book is unreachable',
      afterUnselect.passages.length === 0,
      afterUnselect.note ?? '',
    )

    /* ---- defence in depth: a grant the app could never issue ---- */
    //
    // Found by accident when this test handed B a private edition owned by a
    // real account: the edition_id filter allowed it (B's library row granted
    // it) but the payload's owner_id did not match, and the assertion in
    // searchBooks refused the hit.
    //
    // Worth keeping. It is the one check that still holds if a bug, a bad
    // migration or a manual SQL fix ever creates a user_library row pointing
    // at someone else's private edition.
    console.log('\nownership assertion (a corrupt grant must not read through)')
    const privateEdition = await db.query.editions.findFirst({
      where: (e, { and: all, eq: isEq, ne, isNotNull }) =>
        all(isEq(e.kind, 'private'), isEq(e.indexStatus, 'ready'), isNotNull(e.ownerUserId), ne(e.ownerUserId, B)),
    })

    if (!privateEdition) {
      console.log('  SKIP  no indexed private edition owned by a third party to test with')
    } else {
      await db
        .update(userLibrary)
        .set({ selected: true })
        .where(eq(userLibrary.userId, A))
      await db
        .insert(userLibrary)
        .values({ userId: B, editionId: privateEdition.id, status: 'ready', selected: true })
        .onConflictDoNothing()

      let refused = false
      try {
        await searchBooks({ userId: B, query: 'anything at all', limit: 5 })
      } catch (err) {
        refused = err instanceof Error && err.name === 'AuthzViolationError'
      }
      check("another user's private edition is refused even when granted", refused)

      await db
        .delete(userLibrary)
        .where(and(eq(userLibrary.userId, B), eq(userLibrary.editionId, privateEdition.id)))
    }

    /* ---- a user with no library ---- */
    console.log('\nempty library')
    const empty = await searchBooks({ userId: 'no-such-user', query: 'anything', limit: 5 })
    check('unknown user gets nothing, not everything', empty.passages.length === 0)
    check('and an explicit note instead of an empty array', Boolean(empty.note), empty.note ?? '')
  } finally {
    await cleanup()
  }

  console.log(failures === 0 ? '\nall isolation checks passed' : `\n${failures} CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)

  async function cleanup() {
    await db.delete(userLibrary).where(inArray(userLibrary.userId, [A, B]))
    await db.delete(users).where(inArray(users.id, [A, B]))
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
