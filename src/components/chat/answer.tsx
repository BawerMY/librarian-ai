'use client'

import type { CitationChip } from '@/lib/ai/tools'

const MARKER = /\[\[(c\d+)\]\]/g

/**
 * Render an answer, turning [[cN]] markers into clickable chips.
 *
 * A marker whose citation is unknown is rendered as NOTHING rather than as
 * literal "[[c7]]" or as a dead chip. Three reasons, in order of importance:
 * a chip that opens nothing breaks the promise that every chip is verifiable;
 * raw marker syntax leaking into prose looks broken; and the model does
 * occasionally emit an id it was never given, which is exactly the case the
 * server-side citation map is there to catch.
 */
export function Answer({
  text,
  citations,
  onOpen,
}: {
  text: string
  citations: Record<string, CitationChip>
  onOpen: (citation: CitationChip) => void
}) {
  const paragraphs = text.split(/\n{2,}/).filter((p) => p.trim())

  return (
    <div className="flex flex-col gap-2.5">
      {paragraphs.map((para, i) => (
        <p key={i} className="m-0 text-[15.5px] leading-[1.7]">
          {renderWithChips(para, citations, onOpen)}
        </p>
      ))}
    </div>
  )
}

function renderWithChips(
  text: string,
  citations: Record<string, CitationChip>,
  onOpen: (c: CitationChip) => void,
): React.ReactNode[] {
  const out: React.ReactNode[] = []
  let last = 0
  let key = 0

  for (const match of text.matchAll(MARKER)) {
    const [raw, id] = match
    const at = match.index ?? 0

    if (at > last) out.push(<span key={key++}>{text.slice(last, at)}</span>)
    last = at + raw.length

    const citation = citations[id]
    if (!citation) continue

    out.push(
      <button
        key={key++}
        type="button"
        onClick={() => onOpen(citation)}
        title={`${citation.book} — ${citation.edition}`}
        className="mx-0.5 inline-flex h-[22px] max-w-full items-center gap-1 truncate rounded bg-accent-soft px-2 align-[1px] text-xs font-semibold text-accent transition-colors hover:bg-accent hover:text-surface"
      >
        {chipLabel(citation)}
      </button>,
    )
  }

  if (last < text.length) out.push(<span key={key++}>{text.slice(last)}</span>)
  return out
}

/**
 * "Letters from a Stoic · Letter XIII · p. 48"
 *
 * EPUBs have no page numbers at all, so a percentage position stands in —
 * printing "p. 48" for an EPUB would be a fabricated locator, and the chip's
 * whole job is to be checkable.
 */
export function chipLabel(c: CitationChip): string {
  const where = c.page !== null ? `p. ${c.page}` : `${Math.round(c.posPct * 100)}%`
  return [c.book, c.chapter, where].filter(Boolean).join(' · ')
}
