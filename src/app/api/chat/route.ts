import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  streamText,
  type UIMessage,
  type UIMessageStreamWriter,
} from 'ai'
import { eq } from 'drizzle-orm'

import { auth } from '@/auth'
import { chatMessages, chatSessions, db } from '@/db'
import { forcedAnswerPrompt, needsForcedAnswer, prepareStep, stopWhen } from '@/lib/ai/loop'
import { buildSystemPrompt, formatPassagesForModel } from '@/lib/ai/prompt'
import { assertChatConfigured, chatModel } from '@/lib/ai/registry'
import { buildTools, createCitationStore, toCitationChip } from '@/lib/ai/tools'
import { getLibraryForPrompt } from '@/lib/library'
import { AuthzViolationError } from '@/lib/retrieval/scope'

export const maxDuration = 120

export async function POST(req: Request) {
  // LOCK 1: identity comes from the session, never the request body. Every
  // downstream scope decision is derived from this value alone.
  const session = await auth()
  const userId = session?.user?.id
  if (!userId) return new Response('Unauthorized', { status: 401 })

  try {
    assertChatConfigured()
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : 'Chat model not configured' },
      { status: 503 },
    )
  }

  const body = (await req.json()) as { messages: UIMessage[]; sessionId?: string }
  const messages = body.messages ?? []
  if (!messages.length) return new Response('No messages', { status: 400 })

  const library = await getLibraryForPrompt(userId)
  const sessionId = await ensureSession(userId, body.sessionId, messages)

  const store = createCitationStore()
  const modelMessages = await convertToModelMessages(messages)

  /**
   * GENERATION IS DETACHED FROM THE RESPONSE.
   *
   * It used to run inside createUIMessageStream's execute, with persistence in
   * that stream's onFinish. That onFinish only fires when the RESPONSE stream
   * completes, so closing the tab mid-answer threw the answer away: the model
   * had been paid for, the user came back to their own question and no reply.
   *
   * Now streamText is started here, consumeStream() drives it to completion
   * regardless of who is reading, and persistence happens in a promise nobody
   * awaits from the response path. The response merely observes the same
   * result; if the client vanishes, only the observing stops.
   *
   * The writer is handed to the tools as a getter because it does not exist
   * yet at this point, and stops existing when the client leaves.
   */
  let writerRef: UIMessageStreamWriter | undefined

  // LOCK 2: tools are built here, inside the request, so userId is a closure
  // variable. No tool input schema has a field that could widen scope — there
  // is nothing for an injected instruction to fill in.
  const tools = buildTools({ userId, store, writer: () => writerRef })

  const result = streamText({
    model: chatModel(),
    system: buildSystemPrompt(library),
    messages: modelMessages,
    tools,
    // Shared loop policy: a multi-book question needs one search per idea, but
    // the final step must be prose or the user gets nothing.
    stopWhen,
    prepareStep,
    onError: ({ error }) => {
      if (error instanceof AuthzViolationError) {
        // Unreachable by design: a filter was built wrongly. Treat as an
        // incident, not a bad result.
        console.error('[AUTHZ]', error.message)
      } else {
        console.error('[chat]', error)
      }
    },
  })

  // Drives the generation independently of the client.
  void Promise.resolve(result.consumeStream()).catch((err: unknown) =>
    console.error('[chat] consume', err),
  )

  /** Resolves to a forced-answer stream when one was needed, else null. */
  const settled: Promise<ReturnType<typeof streamText> | null> = (async () => {
    try {
      const text = await result.text

      if (!needsForcedAnswer(text, store.map.size)) {
        await persistAssistant(sessionId, text, store)
        return null
      }

      // A turn that retrieved passages but emitted no prose (or none with a
      // citation) is not an answer — see needsForcedAnswer in lib/ai/loop.ts.
      console.warn(`[chat] no usable answer after tool loop; forcing a reply (session ${sessionId})`)
      const forced = streamText({
        model: chatModel(),
        system: buildSystemPrompt(library),
        messages: [
          ...modelMessages,
          {
            role: 'user',
            content: forcedAnswerPrompt(formatPassagesForModel([...store.map.values()])),
          },
        ],
      })
      void Promise.resolve(forced.consumeStream()).catch((err: unknown) =>
        console.error('[chat] consume forced', err),
      )
      await persistAssistant(sessionId, await forced.text, store)
      return forced
    } catch (err) {
      console.error('[chat] generation failed', err)
      return null
    }
  })()

  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      writerRef = writer
      writer.merge(result.toUIMessageStream({ sendStart: false, sendReasoning: false }))
      const forced = await settled
      if (forced) {
        writer.merge(forced.toUIMessageStream({ sendStart: false, sendReasoning: false }))
      }
    },
  })

  return createUIMessageStreamResponse({ stream, headers: { 'X-Session-Id': sessionId } })
}

/* ------------------------------------------------------------------ */

/**
 * Store the assistant's turn.
 *
 * Called from the detached generation promise rather than a response callback,
 * so an answer is kept whether or not anyone was still listening for it.
 */
async function persistAssistant(
  sessionId: string,
  text: string,
  store: ReturnType<typeof createCitationStore>,
): Promise<void> {
  if (!text.trim()) return

  const citations = Object.fromEntries(
    [...store.map.entries()].map(([id, p]) => [id, toCitationChip(p)]),
  )

  await db.insert(chatMessages).values({
    id: crypto.randomUUID(),
    sessionId,
    role: 'assistant',
    content: text,
    // Only the citations this answer actually referenced.
    citations: pickReferenced(text, citations),
  })

  await db
    .update(chatSessions)
    .set({ updatedAt: new Date() })
    .where(eq(chatSessions.id, sessionId))
}

/**
 * Keep only the markers that appear in the answer.
 *
 * A turn may retrieve 8 passages and cite 3. Storing all 8 would let the
 * passage drawer open text the answer never showed — which is both confusing
 * and extra copyrighted text persisted for no reason.
 */
function pickReferenced<T>(text: string, citations: Record<string, T>): Record<string, T> {
  const used = new Set<string>()
  for (const m of text.matchAll(/\[\[(c\d+)\]\]/g)) used.add(m[1])

  const out: Record<string, T> = {}
  for (const id of used) {
    if (citations[id]) out[id] = citations[id]
  }
  return out
}

/**
 * Resolve the session for this turn, creating it if the client's id is new.
 *
 * The client supplies the id (it is the Chat component's own chatId). That is
 * what fixes the bug where a new conversation minted a FRESH session on every
 * turn: the client had no id to send, so each message became its own
 * "conversation" — one question produced two rows in Recent, one of them an
 * orphan with no reply.
 *
 * Accepting a client id is safe because of the ownership check: an id that
 * exists but belongs to someone else is ignored and a fresh one is generated,
 * so a guessed id can neither read nor append to another user's chat.
 */
async function ensureSession(
  userId: string,
  sessionId: string | undefined,
  messages: UIMessage[],
): Promise<string> {
  if (sessionId) {
    const existing = await db.query.chatSessions.findFirst({
      where: (s, { eq: isEq }) => isEq(s.id, sessionId),
    })

    if (existing) {
      if (existing.userId === userId) {
        await persistLatestUserMessage(sessionId, messages)
        return existing.id
      }
      // Someone else's session: fall through and mint our own rather than
      // erroring, so a stale or guessed id degrades to a new conversation.
    } else {
      await db.insert(chatSessions).values({
        id: sessionId,
        userId,
        title: firstUserText(messages).slice(0, 120) || null,
      })
      await persistLatestUserMessage(sessionId, messages)
      return sessionId
    }
  }

  const id = crypto.randomUUID()
  await db.insert(chatSessions).values({
    id,
    userId,
    title: firstUserText(messages).slice(0, 120) || null,
  })
  await persistLatestUserMessage(id, messages)
  return id
}

async function persistLatestUserMessage(sessionId: string, messages: UIMessage[]): Promise<void> {
  const last = messages[messages.length - 1]
  if (!last || last.role !== 'user') return

  const text = last.parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('')
  if (!text.trim()) return

  await db.insert(chatMessages).values({
    id: crypto.randomUUID(),
    sessionId,
    role: 'user',
    content: text,
    citations: {},
  })
}

function firstUserText(messages: UIMessage[]): string {
  for (const m of messages) {
    if (m.role !== 'user') continue
    const text = m.parts
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join('')
    if (text.trim()) return text.trim()
  }
  return ''
}
