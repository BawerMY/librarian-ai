/**
 * The contract every parser (EPUB, PDF, TXT) produces, and the only thing
 * the chunker consumes. Keeping it narrow is what lets the pipeline treat a
 * Gutenberg EPUB and a user's PDF identically from chunking onward.
 */

export type StructureEntry = {
  /** Short cite label: "Letter XIII", "Book IV", "Ch. 2". */
  chapter: string | null
  /** Long label shown in the passage drawer: "On Groundless Fears". */
  section: string | null
  /** Character offset into `ParsedBook.text` where this span begins. */
  start: number
  /** Exclusive end offset. */
  end: number
  /** Real page number at the start of the span, when the source has pages. */
  pageStart: number | null
}

export type ParsedBook = {
  /** Normalized full text. Paragraphs separated by blank lines. */
  text: string
  /** Ordered, non-overlapping spans covering the whole text. */
  structure: StructureEntry[]
  meta: {
    title?: string
    author?: string
    language?: string
    publisher?: string
    date?: string
    /** dc:rights verbatim, e.g. "Public domain in the USA." */
    rights?: string
  }
  /** True only when page numbers are real, not inferred. */
  hasPages: boolean
}

/**
 * Project Gutenberg wraps every edition in licence boilerplate. It is long,
 * repetitive, and identical across books — left in, it embeds well and then
 * surfaces as a citation. Stripped from both the EPUB and TXT paths.
 */
export function stripGutenbergBoilerplate(text: string): string {
  let out = text

  // Everything before the START marker is Gutenberg's front matter.
  const start = /\*\*\*\s*START OF (?:TH[EI]S|THE) PROJECT GUTENBERG EBOOK[^*]*\*\*\*/i.exec(out)
  if (start) out = out.slice(start.index + start[0].length)

  // Everything from the END marker on is the licence.
  const end = /\*\*\*\s*END OF (?:TH[EI]S|THE) PROJECT GUTENBERG EBOOK[^*]*\*\*\*/i.exec(out)
  if (end) out = out.slice(0, end.index)
  else {
    const legacyEnd = /End of (?:the )?Project Gutenberg(?:'s)? EBook/i.exec(out)
    if (legacyEnd) out = out.slice(0, legacyEnd.index)
  }

  // The licence body can also sit BEFORE the END marker — Gutenberg's footer
  // document opens with "THE FULL PROJECT GUTENBERG LICENSE" and only then
  // prints the END marker, so cutting at the marker alone leaves the whole
  // licence in the text. Indexed, it embeds well and then surfaces as a
  // citation, identical across every book.
  const licence =
    /(?:\*\*\*\s*START:?\s*FULL LICENSE\s*\*\*\*|THE FULL PROJECT GUTENBERG\S* LICENSE|Section 1\.\s*General Terms of Use)/i.exec(
      out,
    )
  if (licence) out = out.slice(0, licence.index)

  return out.trim()
}

/**
 * Spine items that genuinely contain no prose: cover pages and SVG wrappers.
 *
 * `pg-header` and `pg-footer` are deliberately NOT here. Those ids sound like
 * boilerplate, and skipping them cost us most of a book: Gutenberg 147 puts
 * the ENTIRE text of Common Sense inside its 141KB `pg-header` document, so
 * skipping it indexed only the 19KB appendix — 18 chunks of a 25,000-word
 * pamphlet, with no error and no visible symptom beyond the model being unable
 * to find Paine's actual arguments.
 *
 * Boilerplate is removed by its MARKERS instead (see
 * stripGutenbergBoilerplate), which is where the real boundary is.
 */
export const SKIP_SPINE_IDS = new Set(['coverpage-wrapper', 'cover', 'cover-image'])
