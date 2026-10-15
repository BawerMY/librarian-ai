'use client'

import Link from 'next/link'

import type { CitationChip } from '@/lib/ai/tools'

/**
 * The passage drawer from the design: the exact quoted text, with the book,
 * edition and locator around it.
 *
 * Shows only the chunk that was actually cited. There is deliberately no
 * "read more" control here — expanding neighbours is bounded server-side and
 * metered against a lifetime per-book cap, so it is not a thing the UI should
 * invite endlessly. The ellipses either side are honest about the passage
 * being an excerpt.
 */
export function PassageDrawer({
  citation,
  onClose,
  onAsk,
}: {
  citation: CitationChip | null
  onClose: () => void
  onAsk: (citation: CitationChip) => void
}) {
  if (!citation) return null

  const where = citation.page !== null ? `Page ${citation.page}` : `${Math.round(citation.posPct * 100)}% in`
  const loc = [citation.chapter, citation.section].filter(Boolean).join(' · ')

  return (
    <>
      <button
        type="button"
        aria-label="Close passage"
        onClick={onClose}
        className="fixed inset-0 z-40 bg-ink/25"
      />
      <aside className="fixed inset-y-0 right-0 z-50 flex w-full max-w-[420px] flex-col border-l border-line bg-surface shadow-[-24px_0_48px_-32px_rgba(34,28,24,0.35)]">
        <div className="flex shrink-0 items-center justify-between border-b border-line px-5 py-4">
          <span className="eyebrow">Source passage</span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid h-8 w-8 place-items-center rounded text-lg text-muted hover:bg-hover"
          >
            ×
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-5">
          <div className="flex items-start gap-3">
            <span
              aria-hidden
              className="mt-0.5 h-10 w-7 shrink-0 rounded-sm"
              style={{ background: 'var(--color-accent)' }}
            />
            <div className="min-w-0">
              <div className="font-serif text-[19px] leading-tight">{citation.book}</div>
              <div className="text-[13px] text-muted">
                {citation.author}
                {citation.edition ? ` · ${citation.edition}` : ''}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
            {loc && (
              <span className="rounded bg-sidebar px-2 py-1 font-semibold text-ink-3">{loc}</span>
            )}
            <span className="rounded bg-sidebar px-2 py-1 text-muted-2">{where}</span>
          </div>

          <blockquote className="m-0 border-l-2 border-accent pl-4 font-serif text-[17px] leading-[1.65] text-ink">
            …{citation.text}…
          </blockquote>
        </div>

        <div className="flex shrink-0 flex-wrap gap-2 border-t border-line px-5 py-4">
          <button
            type="button"
            onClick={() => onAsk(citation)}
            className="h-10 flex-1 rounded-md bg-accent px-4 text-sm font-semibold text-surface transition-colors hover:bg-accent-hover"
          >
            Ask about this passage
          </button>
          <Link
            href={`/library?q=${encodeURIComponent(citation.book)}`}
            className="flex h-10 items-center rounded-md border border-line-strong px-4 text-sm font-semibold text-ink transition-colors hover:border-ink"
          >
            View in library
          </Link>
        </div>
      </aside>
    </>
  )
}
