import type { ParsedBook, StructureEntry } from './types'

/**
 * Chunking is done PER STRUCTURE SPAN, not over the flat text.
 *
 * That guarantees no chunk straddles a chapter boundary, which in turn makes
 * every citation's chapter label exactly right rather than mostly right. A
 * chunk that spans the end of Book III and the start of Book IV has no honest
 * label, and a citation chip that opens on the wrong chapter is the failure
 * users notice first — chips exist to be clicked.
 */

export type Chunk = {
  idx: number
  text: string
  chapter: string | null
  section: string | null
  page: number | null
  /** 0-1 position in the book; the locator when `page` is null (EPUB, txt). */
  posPct: number
  /** Estimated — see CHARS_PER_TOKEN. */
  tokenCount: number
}

export type ChunkOptions = {
  /** Target size in tokens. */
  targetTokens?: number
  /** Overlap between consecutive chunks, in tokens. */
  overlapTokens?: number
  /** Hard ceiling. Must stay below the embedding model's context window. */
  maxTokens?: number
  /**
   * Spans shorter than this are carried forward and prepended to the next
   * chunk rather than emitted alone. Headings ("HIS FIRST BOOK") arrive as
   * ~18-character spans; as standalone chunks they are noise, as a prefix to
   * the following passage they help retrieval.
   */
  minSpanChars?: number
}

/**
 * Calibrated against bge-large's own tokenizer, not guessed.
 * `scripts/calibrate-tokens.ts` measures it via Ollama's prompt_eval_count.
 *
 * Measured over Meditations (480 chunks, 50 sampled):
 *   chars/token   min 3.63   p50 4.23   p95 4.61
 *   actual tokens p50 259    max 324    window 512
 *
 * Set just below the observed minimum so the estimate over-counts dense text
 * rather than under-counting it. The 188 tokens of worst-case headroom is the
 * real safety margin — Ollama truncates past 512 silently, with no error and
 * no visible symptom beyond quietly worse retrieval.
 */
export const CHARS_PER_TOKEN = 3.6

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

export function chunkBook(book: ParsedBook, opts: ChunkOptions = {}): Chunk[] {
  const targetTokens = opts.targetTokens ?? 330
  const overlapTokens = opts.overlapTokens ?? 60
  const maxTokens = opts.maxTokens ?? 440
  const minSpanChars = opts.minSpanChars ?? 150

  const targetChars = Math.floor(targetTokens * CHARS_PER_TOKEN)
  const overlapChars = Math.floor(overlapTokens * CHARS_PER_TOKEN)
  const maxChars = Math.floor(maxTokens * CHARS_PER_TOKEN)

  const total = book.text.length || 1
  const chunks: Chunk[] = []
  let carry = ''

  for (const span of book.structure) {
    const spanText = book.text.slice(span.start, span.end).trim()
    if (!spanText) continue

    if (spanText.length < minSpanChars) {
      carry = carry ? `${carry} ${spanText}` : spanText
      continue
    }

    const prefix = carry
    carry = ''

    const units = splitIntoUnits(spanText)
    let buffer: string[] = []
    let bufferChars = 0
    let spanCursor = 0 // chars consumed from spanText, for the global offset

    const flush = (isFirst: boolean) => {
      if (!buffer.length) return
      const body = buffer.join(' ').trim()
      if (!body) return
      const text = isFirst && prefix ? `${prefix} ${body}` : body
      const globalStart = span.start + spanCursor - bufferChars

      chunks.push({
        idx: chunks.length,
        text,
        chapter: span.chapter,
        section: span.section,
        page: pageFor(span, globalStart, book),
        posPct: clamp01(globalStart / total),
        tokenCount: estimateTokens(text),
      })
    }

    let emittedFromSpan = false
    for (const unit of units) {
      // A single sentence longer than the ceiling has to be force-split, or it
      // would be silently truncated by the model at 512 tokens.
      const pieces = unit.length > maxChars ? hardSplit(unit, maxChars) : [unit]

      for (const piece of pieces) {
        if (bufferChars > 0 && bufferChars + piece.length + 1 > targetChars) {
          flush(!emittedFromSpan)
          emittedFromSpan = true
          const kept = takeOverlap(buffer, overlapChars)
          buffer = kept.units
          bufferChars = kept.chars
        }
        buffer.push(piece)
        bufferChars += piece.length + 1
        spanCursor += piece.length + 1
      }
    }

    flush(!emittedFromSpan)
  }

  // A trailing heading with nothing after it: attach to the last chunk rather
  // than dropping text on the floor.
  if (carry && chunks.length) {
    const last = chunks[chunks.length - 1]
    last.text = `${last.text} ${carry}`
    last.tokenCount = estimateTokens(last.text)
  }

  return chunks.map((c, i) => ({ ...c, idx: i }))
}

/* ------------------------------------------------------------------ */

/**
 * Split into sentences, treating paragraph breaks as hard boundaries.
 *
 * Abbreviations ("A.D. 121", "Mr. Smith", "p. 48") are the usual source of
 * bad splits, so a period only ends a sentence when followed by whitespace
 * and an opening character, and not when preceded by a known abbreviation.
 */
const ABBREVIATIONS =
  /\b(?:[A-Z]|Mr|Mrs|Ms|Dr|Prof|St|Sr|Jr|vs|etc|cf|ibid|viz|al|ca|c|p|pp|vol|ch|ed|trans|A\.D|B\.C|i\.e|e\.g)$/

function splitIntoUnits(text: string): string[] {
  const out: string[] = []

  for (const para of text.split(/\n{2,}/)) {
    const trimmed = para.replace(/\s+/g, ' ').trim()
    if (!trimmed) continue

    let start = 0
    for (let i = 0; i < trimmed.length; i++) {
      const ch = trimmed[i]
      if (ch !== '.' && ch !== '!' && ch !== '?') continue

      // Consume runs like "?!" and trailing quotes/brackets.
      let j = i
      while (j + 1 < trimmed.length && '.!?'.includes(trimmed[j + 1])) j++
      while (j + 1 < trimmed.length && `"'”’)]`.includes(trimmed[j + 1])) j++

      const next = trimmed[j + 1]
      if (next !== undefined && next !== ' ') continue

      const after = trimmed.slice(j + 2, j + 3)
      // Lowercase after the break means it was an abbreviation, not an end.
      if (after && after === after.toLowerCase() && /[a-z]/.test(after)) continue
      if (ABBREVIATIONS.test(trimmed.slice(Math.max(0, i - 12), i))) continue

      out.push(trimmed.slice(start, j + 1).trim())
      start = j + 2
      i = j + 1
    }

    const tail = trimmed.slice(start).trim()
    if (tail) out.push(tail)
  }

  return out.filter(Boolean)
}

/** Keep trailing units up to `overlapChars`, preserving order. */
function takeOverlap(units: string[], overlapChars: number): { units: string[]; chars: number } {
  if (overlapChars <= 0) return { units: [], chars: 0 }
  const kept: string[] = []
  let chars = 0
  for (let i = units.length - 1; i >= 0; i--) {
    const next = chars + units[i].length + 1
    if (next > overlapChars && kept.length) break
    kept.unshift(units[i])
    chars = next
    if (chars >= overlapChars) break
  }
  return { units: kept, chars }
}

/** Last-resort split for a sentence that exceeds the model's window. */
function hardSplit(text: string, maxChars: number): string[] {
  const out: string[] = []
  let i = 0
  while (i < text.length) {
    let end = Math.min(i + maxChars, text.length)
    if (end < text.length) {
      const space = text.lastIndexOf(' ', end)
      if (space > i + maxChars / 2) end = space
    }
    out.push(text.slice(i, end).trim())
    i = end
  }
  return out.filter(Boolean)
}

function pageFor(span: StructureEntry, _offset: number, book: ParsedBook): number | null {
  if (!book.hasPages) return null
  return span.pageStart
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n
}
