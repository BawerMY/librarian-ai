/**
 * The grounding test.
 *
 *   pnpm verify:chat
 *
 * Exercises the real tool loop against the real index and asserts the
 * behaviour the whole product rests on:
 *
 *   1. it searches before answering
 *   2. every citation marker it emits resolves to a passage it was actually given
 *   3. it refuses rather than inventing when the books don't cover something
 *   4. a multi-book question triggers more than one search
 *
 * Point 2 is the one that cannot be allowed to regress: a chip is an invitation
 * to verify, so a marker pointing at nothing — or at the wrong passage — is the
 * most visible failure this app can have.
 *
 * Costs a few cents per run (real model calls).
 */
import { config } from 'dotenv'

config({ path: '.env.local', quiet: true })

const USER = 'test-chat-user'

let failures = 0
function check(label: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

async function main() {
  const { generateText } = await import('ai')
  const { db, userLibrary, users } = await import('@/db')
  const { forcedAnswerPrompt, needsForcedAnswer, prepareStep, stopWhen } = await import('@/lib/ai/loop')
  const { buildSystemPrompt, formatPassagesForModel } = await import('@/lib/ai/prompt')
  const { assertChatConfigured, chatModel } = await import('@/lib/ai/registry')
  const { buildTools, createCitationStore } = await import('@/lib/ai/tools')
  const { getLibraryForPrompt } = await import('@/lib/library')
  const { inArray } = await import('drizzle-orm')

  assertChatConfigured()

  const ready = await db.query.editions.findMany({
    where: (e, { eq }) => eq(e.indexStatus, 'ready'),
  })
  if (!ready.length) {
    console.error('No indexed editions. Run: pnpm ingest 2680 --now')
    process.exit(1)
  }

  await cleanup()
  await db.insert(users).values({ id: USER, email: `${USER}@test.local`, name: 'Test' })
  await db.insert(userLibrary).values(
    ready.map((e) => ({
      userId: USER,
      editionId: e.id,
      status: 'ready' as const,
      selected: true,
    })),
  )

  const library = await getLibraryForPrompt(USER)
  console.log(`library: ${library.map((b) => b.title.slice(0, 32)).join(', ')}\n`)

  try {
    await ask(
      'grounded answer with resolvable citations',
      'Where did I read that you can retreat into yourself rather than seeking out country villages?',
      (text, store, steps) => {
        const markers = [...text.matchAll(/\[\[(c\d+)\]\]/g)].map((m) => m[1])
        check('searched before answering', steps.some((s) => s.toolCalls.length > 0))
        check('emitted at least one citation marker', markers.length > 0, `${markers.length} found`)
        check(
          'every marker resolves to a retrieved passage',
          markers.every((m) => store.map.has(m)),
          markers.filter((m) => !store.map.has(m)).join(',') || 'all resolve',
        )
        const cited = markers.map((m) => store.map.get(m)!).filter(Boolean)
        check(
          'cited passages carry a chapter label',
          cited.length > 0 && cited.every((p) => p.chapter),
          cited.map((p) => p.chapter ?? 'null').join(' | '),
        )
      },
    )

    await ask(
      'refusal instead of invention',
      'What does Atomic Habits say about habit stacking?',
      (text, store) => {
        const markers = [...text.matchAll(/\[\[(c\d+)\]\]/g)].map((m) => m[1])
        const refused =
          /\b(not|don't|doesn't|isn't|no)\b.{0,60}\b(library|books?|added|have|cover|find)\b/i.test(
            text,
          ) || /\b(add|upload)\b/i.test(text)
        check('declined rather than answering from memory', refused, text.slice(0, 120))
        check(
          'no citation markers invented for a book it lacks',
          markers.every((m) => store.map.has(m)),
          markers.join(',') || 'none emitted',
        )
      },
    )

    if (ready.length > 1) {
      await ask(
        'multi-book question searches more than once',
        'How do the ideas about self-control in my books relate to each other across different authors?',
        (_text, _store, steps) => {
          const searches = steps.flatMap((s) =>
            s.toolCalls.filter((c) => c.toolName === 'searchBooks'),
          )
          check('issued multiple searches', searches.length >= 2, `${searches.length} searches`)
        },
      )
    }
  } finally {
    await cleanup()
  }

  console.log(failures === 0 ? '\nall grounding checks passed' : `\n${failures} CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)

  type Step = { toolCalls: { toolName: string }[] }

  async function ask(
    label: string,
    question: string,
    assert: (
      text: string,
      store: ReturnType<typeof createCitationStore>,
      steps: Step[],
    ) => void,
  ) {
    console.log(`${label}\n  Q: ${question}`)
    const store = createCitationStore()
    const tools = buildTools({ userId: USER, store })

    const res = await generateText({
      model: chatModel(),
      system: buildSystemPrompt(library),
      prompt: question,
      tools,
      stopWhen,
      prepareStep,
    })

    let answer = res.text
    let forcedAnswer = false
    if (needsForcedAnswer(answer, store.map.size)) {
      forcedAnswer = true
      const forced = await generateText({
        model: chatModel(),
        system: buildSystemPrompt(library),
        messages: [
          { role: 'user', content: question },
          {
            role: 'user',
            content: forcedAnswerPrompt(formatPassagesForModel([...store.map.values()])),
          },
        ],
      })
      answer = forced.text
    }

    if (process.argv.includes('--verbose')) {
      console.log(`  finishReason: ${JSON.stringify(res.finishReason)}  steps: ${res.steps.length}`)
      res.steps.forEach((s, i) => {
        const tools = s.toolCalls.map((c) => c.toolName).join(',') || '-'
        console.log(
          `    step ${i}  finish=${JSON.stringify(s.finishReason)}  tools=${tools}  textLen=${(s.text ?? '').length}`,
        )
      })
      console.log(`    citation store: ${store.map.size} passages`)
      if (forcedAnswer) console.log('    (answer was FORCED — tool loop produced none)')
    }

    console.log(`  A: ${answer.replace(/\s+/g, ' ').slice(0, 300) || '(EMPTY)'}`)
    // Asserted for EVERY question, not just the grounded one: an empty answer
    // is the failure mode a step budget produces, and it is invisible unless
    // checked here.
    check(
      'produced a non-empty answer',
      answer.trim().length > 0,
      `${answer.length} chars${forcedAnswer ? ' (forced)' : ''}`,
    )
    assert(answer, store, res.steps as unknown as Step[])
    console.log()
  }

  async function cleanup() {
    const { revealLog } = await import('@/db')
    await db.delete(revealLog).where(inArray(revealLog.userId, [USER]))
    await db.delete(userLibrary).where(inArray(userLibrary.userId, [USER]))
    await db.delete(users).where(inArray(users.id, [USER]))
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
