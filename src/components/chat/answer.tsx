'use client'

import { Children, isValidElement, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

import type { CitationChip } from '@/lib/ai/tools'

const MARKER = /\[\[(c\d+)\]\]/g

/**
 * Render an answer as Markdown, turning [[cN]] markers into clickable chips.
 *
 * The model writes Markdown — bold, headings, lists — and before this it was
 * shown raw, so an answer read as `**Epictetus:** ...` with literal asterisks.
 * Markdown is parsed with GFM, then every text node in the result is walked
 * for markers; doing it after parsing is what keeps a chip working inside a
 * list item or a bold run.
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
  // Walks whatever Markdown produced for one element and swaps markers out of
  // the plain strings, leaving parsed elements (<strong>, <code>, …) alone.
  const chips = (children: ReactNode): ReactNode =>
    Children.map(children, (child) => {
      if (typeof child === 'string') return renderWithChips(child, citations, onOpen)
      if (isValidElement<{ children?: ReactNode }>(child) && child.props.children) {
        return { ...child, props: { ...child.props, children: chips(child.props.children) } }
      }
      return child
    })

  const components: Components = {
    p: ({ children }) => <p className="m-0 text-[15.5px] leading-[1.7]">{chips(children)}</p>,
    h1: ({ children }) => (
      <h1 className="m-0 mt-1 text-[19px] font-semibold leading-snug">{chips(children)}</h1>
    ),
    h2: ({ children }) => (
      <h2 className="m-0 mt-1 text-[17px] font-semibold leading-snug">{chips(children)}</h2>
    ),
    h3: ({ children }) => (
      <h3 className="m-0 mt-1 text-[15.5px] font-semibold leading-snug">{chips(children)}</h3>
    ),
    ul: ({ children }) => (
      <ul className="m-0 flex list-disc flex-col gap-1 pl-5 text-[15.5px] leading-[1.7]">
        {children}
      </ul>
    ),
    ol: ({ children }) => (
      <ol className="m-0 flex list-decimal flex-col gap-1 pl-5 text-[15.5px] leading-[1.7]">
        {children}
      </ol>
    ),
    li: ({ children }) => <li className="m-0">{chips(children)}</li>,
    strong: ({ children }) => <strong className="font-semibold">{chips(children)}</strong>,
    em: ({ children }) => <em className="italic">{chips(children)}</em>,
    blockquote: ({ children }) => (
      <blockquote className="m-0 border-l-2 border-line-strong pl-3 text-[15.5px] italic leading-[1.7] text-muted">
        {chips(children)}
      </blockquote>
    ),
    hr: () => <hr className="my-1 border-0 border-t border-line" />,
    code: ({ children, className }) =>
      // Fenced blocks arrive wrapped in <pre>; only inline code needs a chip.
      className ? (
        <code className="font-mono text-[13.5px]">{children}</code>
      ) : (
        <code className="rounded bg-sidebar px-1 py-0.5 font-mono text-[13.5px]">{children}</code>
      ),
    pre: ({ children }) => (
      <pre className="m-0 overflow-x-auto rounded-md bg-sidebar p-3 text-[13.5px] leading-normal">
        {children}
      </pre>
    ),
    // Links the model writes point outside the library; the chips are the only
    // in-app navigation, so these open in a new tab and never steal the view.
    a: ({ children, href }) => (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-accent underline underline-offset-2"
      >
        {chips(children)}
      </a>
    ),
    table: ({ children }) => (
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[14px]">{children}</table>
      </div>
    ),
    th: ({ children }) => (
      <th className="border border-line px-2 py-1 text-left font-semibold">{chips(children)}</th>
    ),
    td: ({ children }) => (
      <td className="border border-line px-2 py-1 align-top">{chips(children)}</td>
    ),
  }

  return (
    <div className="flex flex-col gap-2.5">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
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
