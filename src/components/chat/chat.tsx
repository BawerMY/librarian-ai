'use client'

import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport, type UIMessage } from 'ai'
import { useEffect, useMemo, useRef, useState } from 'react'

import { notifyChatUpdated } from './chat-events'

import type { CitationChip } from '@/lib/ai/tools'

import { Answer } from './answer'
import { PassageDrawer } from './passage-drawer'

export function Chat({
  chatId,
  sessionId,
  initialMessages,
  initialCitations,
  searchableCount,
}: {
  /** Stable per-conversation id; changing it remounts and clears state. */
  chatId: string
  sessionId?: string
  initialMessages: UIMessage[]
  /** Citations persisted with past messages, so reopening a chat shows the
   *  original chips rather than re-running retrieval. */
  initialCitations: Record<string, CitationChip>
  searchableCount: number
}) {
  const [draft, setDraft] = useState('')
  const [open, setOpen] = useState<CitationChip | null>(null)
  const [recovered, setRecovered] = useState<Record<string, CitationChip>>({})
  const scrollRef = useRef<HTMLDivElement>(null)

  const { messages, setMessages, sendMessage, status, error } = useChat({
    id: chatId,
    messages: initialMessages,
    transport: new DefaultChatTransport({
      api: '/api/chat',
      // chatId IS the session id. Previously only an existing sessionId was
      // sent, so a NEW conversation had none — and the server minted a fresh
      // session on every turn. One question produced two entries in Recent,
      // the second an orphan with no reply.
      body: { sessionId: sessionId ?? chatId },
    }),
  })

  /**
   * Citations arrive two ways: inlined with historical messages, and streamed
   * as `data-citations` parts while the answer is being written. Merging both
   * into one map means the chip renderer does not care which turn a marker
   * came from.
   */
  const citations = useMemo(() => {
    const map: Record<string, CitationChip> = { ...initialCitations, ...recovered }
    for (const m of messages) {
      for (const part of m.parts) {
        if (part.type === 'data-citations') {
          for (const c of part.data as CitationChip[]) map[c.id] = c
        }
      }
    }
    return map
  }, [messages, initialCitations, recovered])

  const busy = status === 'submitted' || status === 'streaming'

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight
    })
  }, [messages])

  // Tell the sidebar a turn finished so "Recent" picks up the new title.
  const wasBusy = useRef(false)
  useEffect(() => {
    if (wasBusy.current && !busy) notifyChatUpdated()
    wasBusy.current = busy
  }, [busy])

  /**
   * Pick up an answer that completed while this page was closed.
   *
   * The server drains its own stream (consumeStream), so generation finishes
   * and is persisted even if the browser went away mid-answer. What was
   * missing was the client ever looking: on load, a conversation whose last
   * message is the user's own would sit there forever showing a question with
   * no reply.
   */
  const awaitingReply =
    !busy && messages.length > 0 && messages[messages.length - 1]?.role === 'user'

  useEffect(() => {
    if (!awaitingReply) return
    const id = sessionId ?? chatId
    let alive = true

    const poll = async () => {
      try {
        const res = await fetch('/api/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: id }),
        })
        if (!res.ok || !alive) return
        const data = (await res.json()) as {
          messages: { id: string; role: 'user' | 'assistant'; content: string; citations: Record<string, CitationChip> }[]
        }
        const last = data.messages[data.messages.length - 1]
        if (!last || last.role !== 'assistant') return

        setMessages(
          data.messages.map((m) => ({
            id: m.id,
            role: m.role,
            parts: [{ type: 'text' as const, text: m.content }],
          })),
        )
        setRecovered((prev) => ({
          ...prev,
          ...Object.assign({}, ...data.messages.map((m) => m.citations ?? {})),
        }))
        notifyChatUpdated()
      } catch {
        // Keep waiting; the next tick will try again.
      }
    }

    void poll()
    const t = setInterval(poll, 4000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [awaitingReply, sessionId, chatId, setMessages])

  function ask(text: string) {
    const t = text.trim()
    if (!t || busy) return
    setDraft('')

    // Put the session in the URL immediately, with replaceState rather than a
    // navigation so the in-flight stream is not torn down. Without this, a
    // refresh mid-answer returned to a blank /chat and the conversation
    // looked lost — it was in the database the whole time, just unreachable.
    if (!sessionId && typeof window !== 'undefined') {
      window.history.replaceState(null, '', `/chat/${chatId}`)
    }

    notifyChatUpdated()
    void sendMessage({ text: t })
  }

  const empty = messages.length === 0

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[720px] flex-col gap-6 px-5 py-8">
          {empty && (
            <div className="flex flex-col gap-5 pt-[clamp(16px,6vh,64px)]">
              <h1 className="m-0 text-[clamp(30px,5vw,44px)] leading-[1.05]">
                What are you trying to remember?
              </h1>
              <p className="m-0 text-[16px] leading-relaxed text-muted">
                Describe it however it comes to mind — a phrase, an idea, a vague feeling of which
                book it was.
              </p>
              {searchableCount === 0 && (
                <p className="m-0 rounded-md border border-warn-fg/20 bg-warn-bg p-3 text-sm leading-relaxed text-warn-fg">
                  No books are searchable yet. Add one from{' '}
                  <a href="/library" className="underline">
                    your library
                  </a>{' '}
                  — a public-domain book is one click.
                </p>
              )}
            </div>
          )}

          {messages.map((m) => {
            const text = m.parts
              .filter((p) => p.type === 'text')
              .map((p) => (p as { text: string }).text)
              .join('')

            if (m.role === 'user') {
              return (
                <div key={m.id} className="flex justify-end">
                  <div className="max-w-[86%] rounded-[10px_10px_2px_10px] bg-sidebar px-4 py-3 text-[15px] leading-normal">
                    {text}
                  </div>
                </div>
              )
            }

            return (
              <div key={m.id} className="flex flex-col gap-2.5">
                <div className="eyebrow">LibrarianAI</div>
                {text ? (
                  <Answer text={text} citations={citations} onOpen={setOpen} />
                ) : (
                  <ToolActivity message={m} searchableCount={searchableCount} />
                )}
              </div>
            )
          })}

          {awaitingReply && (
            <div className="flex flex-col gap-2.5">
              <div className="eyebrow">LibrarianAI</div>
              <div className="text-[15px] text-muted">
                Still answering — this keeps running on the server, so you can leave and come
                back.
              </div>
            </div>
          )}

          {busy && messages[messages.length - 1]?.role === 'user' && (
            <div className="flex flex-col gap-2.5">
              <div className="eyebrow">LibrarianAI</div>
              <div className="text-[15px] text-muted">
                Looking through {searchableCount} {searchableCount === 1 ? 'book' : 'books'}…
              </div>
            </div>
          )}

          {error && (
            <p className="m-0 rounded-md border border-accent/30 bg-accent-soft p-3 text-sm text-accent">
              {error.message || 'Something went wrong.'}
            </p>
          )}
        </div>
      </div>

      <div className="shrink-0 border-t border-line bg-paper px-5 py-4">
        <div className="mx-auto flex w-full max-w-[720px] items-center gap-2 rounded-lg border border-line-input bg-surface px-3 focus-within:border-accent">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                ask(draft)
              }
            }}
            placeholder="Ask about anything you've read"
            className="h-12 min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-faint"
          />
          <button
            type="button"
            onClick={() => ask(draft)}
            disabled={busy || !draft.trim()}
            className="h-9 shrink-0 rounded-md bg-accent px-4 text-sm font-semibold text-surface transition-colors hover:bg-accent-hover disabled:bg-line-strong"
          >
            {busy ? '…' : 'Ask'}
          </button>
        </div>
      </div>

      <PassageDrawer
        citation={open}
        onClose={() => setOpen(null)}
        onAsk={(c) => {
          setOpen(null)
          setDraft(`About ${c.book}, ${c.chapter ?? 'that passage'}: `)
        }}
      />
    </div>
  )
}

/**
 * While the model is searching, show what it is doing rather than a spinner.
 * Retrieval takes a second or two and naming the book being searched makes
 * the wait legible.
 */
function ToolActivity({
  message,
  searchableCount,
}: {
  message: UIMessage
  searchableCount: number
}) {
  const calls = message.parts.filter((p) => p.type.startsWith('tool-'))
  if (!calls.length) {
    return (
      <div className="text-[15px] text-muted">
        Looking through {searchableCount} {searchableCount === 1 ? 'book' : 'books'}…
      </div>
    )
  }
  return (
    <div className="text-[15px] text-muted">
      Searching your books… <span className="text-faint">({calls.length})</span>
    </div>
  )
}
