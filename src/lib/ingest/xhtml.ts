/**
 * XHTML -> plain text, keeping a map of element ids to character offsets.
 *
 * The anchor map is the point of this module. EPUB table-of-contents entries
 * address sections by fragment ("chapter-2.xhtml#pgepubid00004"), and a single
 * spine document routinely contains many of them — Gutenberg's Meditations puts
 * three navPoints in its first file. Without offsets we could only attribute
 * chapters at file granularity, which would mislabel most citations.
 *
 * Hand-rolled rather than via a DOM or XML library: EPUB content is XHTML with
 * arbitrary inline markup and entity soup, and all we need is text plus id
 * positions. A parser configured loosely enough to survive real-world files
 * ends up larger than this.
 */

const BLOCK_TAGS = new Set([
  'p', 'div', 'section', 'article', 'blockquote', 'pre',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'dl', 'table', 'tr', 'hr', 'figure', 'figcaption',
])

const LINE_TAGS = new Set(['br', 'li', 'dt', 'dd', 'td', 'th'])

/** Dropped wholesale, content included. */
const SKIP_TAGS = new Set(['script', 'style', 'head', 'title', 'svg'])

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ',
  mdash: '—', ndash: '–', hellip: '…',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  laquo: '«', raquo: '»', deg: '°', sect: '§',
  copy: '©', reg: '®', trade: '™', middot: '·',
  oelig: 'œ', aelig: 'æ', eacute: 'é', egrave: 'è',
  agrave: 'à', ccedil: 'ç', uuml: 'ü', ouml: 'ö',
  auml: 'ä', szlig: 'ß', pound: '£', dagger: '†',
}

export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body: string) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10)
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match
      try {
        return String.fromCodePoint(code)
      } catch {
        return match
      }
    }
    return NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()] ?? match
  })
}

export type XhtmlText = {
  text: string
  /** element id -> character offset into `text` */
  anchors: Record<string, number>
}

export function extractXhtmlText(xhtml: string): XhtmlText {
  const out: string[] = []
  let len = 0
  const anchors: Record<string, number> = {}

  // How many newlines currently sit at the tail of `out`. Tracked rather than
  // inspected so we never have to re-join the buffer to look backwards.
  let pendingBreaks = 0
  let wroteAnything = false

  const flushBreaks = () => {
    if (!wroteAnything) {
      pendingBreaks = 0
      return
    }
    if (pendingBreaks > 0) {
      const nl = '\n'.repeat(Math.min(pendingBreaks, 2))
      out.push(nl)
      len += nl.length
      pendingBreaks = 0
    }
  }

  const pushText = (raw: string) => {
    const decoded = decodeEntities(raw)
    // Collapse runs of whitespace, including the newlines that EPUB files use
    // for source formatting. Real paragraph breaks come from block tags.
    const collapsed = decoded.replace(/\s+/g, ' ')
    if (collapsed === '' || collapsed === ' ') {
      // Inter-tag whitespace still separates words: "<i>a</i> <b>b</b>".
      if (collapsed === ' ' && wroteAnything && pendingBreaks === 0) {
        out.push(' ')
        len += 1
      }
      return
    }
    flushBreaks()
    out.push(collapsed)
    len += collapsed.length
    wroteAnything = true
  }

  const body = stripComments(xhtml)

  const TAG = /<\/?([a-zA-Z][a-zA-Z0-9:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g
  let cursor = 0
  let skipDepth = 0
  let skipTag = ''
  let match: RegExpExecArray | null

  while ((match = TAG.exec(body)) !== null) {
    const [full, rawName, attrs = ''] = match
    const name = rawName.toLowerCase()
    const closing = full[1] === '/'
    const selfClosing = full.endsWith('/>')

    if (skipDepth === 0) {
      pushText(body.slice(cursor, match.index))
    }
    cursor = match.index + full.length

    if (skipDepth > 0) {
      if (name === skipTag) {
        if (closing) skipDepth--
        else if (!selfClosing) skipDepth++
      }
      continue
    }

    if (!closing && SKIP_TAGS.has(name) && !selfClosing) {
      skipDepth = 1
      skipTag = name
      continue
    }

    if (!closing) {
      // Record every id we see. Offsets land at the current text position,
      // which is where that element's content begins.
      const id = readAttr(attrs, 'id')
      if (id && !(id in anchors)) anchors[id] = len + (pendingBreaks > 0 && wroteAnything ? Math.min(pendingBreaks, 2) : 0)
    }

    if (BLOCK_TAGS.has(name)) pendingBreaks = Math.max(pendingBreaks, 2)
    else if (LINE_TAGS.has(name)) pendingBreaks = Math.max(pendingBreaks, 1)
  }

  if (skipDepth === 0) pushText(body.slice(cursor))

  const text = out.join('').trim()

  // An anchor can land past the end after the trailing trim (an empty final
  // element, which Gutenberg files do contain). Clamp rather than drop, so the
  // section still resolves to the end of the document.
  for (const key of Object.keys(anchors)) {
    if (anchors[key] > text.length) anchors[key] = text.length
  }

  return { text, anchors }
}

function stripComments(s: string): string {
  return (
    s
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      // Processing instructions and the doctype are not element tags, so the
      // tag scanner below would pass them through as body text — the XML
      // declaration would then open every chapter of every EPUB.
      .replace(/<\?[\s\S]*?\?>/g, '')
      .replace(/<!DOCTYPE[^>]*>/gi, '')
  )
}

function readAttr(attrs: string, name: string): string | null {
  const re = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i')
  const m = re.exec(attrs)
  if (!m) return null
  return decodeEntities(m[2] ?? m[3] ?? m[4] ?? '')
}

export const __testing = { readAttr, stripComments }
