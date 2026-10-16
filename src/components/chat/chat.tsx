'use client'

import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport, type UIMessage } from 'ai'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'

import { notifyChatUpdated } from './chat-events'

import type { CitationChip } from '@/lib/ai/tools'

import { Answer } from './answer'
import * as partial from './partial-answer'
import type { Snapshot } from './partial-answer'
import { PassageDrawer } from './passage-drawer'

function textOf(message: UIMessage): string {
  return message.parts
    .filter((p) => p.type === 'text')
    .map((p) => (p as { text: string }).text)
    .join('')
}

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
   * Keep what the answer looked like when the view went away.
   *
   * Leaving the chat unmounts this component and aborts the response stream,
   * so the half-written answer on screen was simply gone on return: the user
   * saw three paragraphs, switched to the library, came back, and got "Still
   * answering" with nothing under it. Generation never stopped — only the
   * reader did — so the text is worth holding on to.
   *
   * sessionStorage, not state: it has to survive the unmount, and it is
   * per-tab and disposable, which is exactly the lifetime of a draft answer.
   */
  const storageKey = partial.key(sessionId ?? chatId)

  const raw = useSyncExternalStore(
    partial.subscribe,
    () => partial.read(storageKey),
    () => null,
  )

  const snapshot = useMemo<Snapshot | null>(() => {
    if (!raw) return null
    try {
      return JSON.parse(raw) as Snapshot
    } catch {
      return null
    }
  }, [raw])

  /**
   * Citations arrive two ways: inlined with historical messages, and streamed
   * as `data-citations` parts while the answer is being written. Merging both
   * into one map means the chip renderer does not care which turn a marker
   * came from.
   */
  const citations = useMemo(() => {
    const map: Record<string, CitationChip> = {
      ...initialCitations,
      ...(snapshot?.citations ?? {}),
      ...recovered,
    }
    for (const m of messages) {
      for (const part of m.parts) {
        if (part.type === 'data-citations') {
          for (const c of part.data as CitationChip[]) map[c.id] = c
        }
      }
    }
    return map
  }, [messages, initialCitations, recovered, snapshot])

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
    const last = messages[messages.length - 1]
    if (last?.role !== 'assistant') return

    if (busy) {
      const text = textOf(last)
      if (text) partial.save(storageKey, { text, citations })
    } else {
      // The real answer is on screen (streamed to the end, or recovered from
      // the database); the stand-in has nothing left to stand in for.
      partial.clear(storageKey)
    }
  }, [messages, busy, citations, storageKey])

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

    // The session row is written by the server, so announce the chat here with
    // its id and title: the sidebar shows it at once instead of waiting for a
    // poll to notice a row that did not exist when the list was last fetched.
    notifyChatUpdated({ id: sessionId ?? chatId, title: t.slice(0, 120) })
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
            const text = textOf(m)

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

          {/* Reopening a chat mid-answer looks exactly like never having left
              it: the text so far if there is any, otherwise the same searching
              line a fresh question shows. Where the work is happening is not
              something the reader should have to think about. */}
          {(awaitingReply || (busy && messages[messages.length - 1]?.role === 'user')) && (
            <div className="flex flex-col gap-2.5">
              <div className="eyebrow">LibrarianAI</div>
              {snapshot?.text ? (
                <Answer text={snapshot.text} citations={citations} onOpen={setOpen} />
              ) : (
                <Searching searchableCount={searchableCount} />
              )}
            </div>
          )}

          {error && (
            <p className="m-0 rounded-md border border-accent/30 bg-accent-soft p-3 text-sm text-accent">
              {error.message || 'Something went wrong.'}
            </p>
          )}
        </div>
      </div>

      <div className="shrink-0 bg-paper px-5 py-4">
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

/** The one "work is happening" line, so a resumed answer and a fresh one
 *  cannot drift apart in wording. */
function Searching({ searchableCount }: { searchableCount: number }) {
  return (
    <div className="text-[15px] text-muted">
      Looking through {searchableCount} {searchableCount === 1 ? 'book' : 'books'}…
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
  if (!calls.length) return <Searching searchableCount={searchableCount} />
  return (
    <div className="text-[15px] text-muted">
      Searching your books… <span className="text-faint">({calls.length})</span>
    </div>
  )
}
