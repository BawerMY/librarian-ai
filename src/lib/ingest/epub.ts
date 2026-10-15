import { XMLParser } from 'fast-xml-parser'
import JSZip from 'jszip'

import { SKIP_SPINE_IDS, stripGutenbergBoilerplate, type ParsedBook, type StructureEntry } from './types'
import { extractXhtmlText } from './xhtml'

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  // dc:title -> title, opf:role -> role. Publishers are inconsistent about
  // which prefixes they declare, so normalising them away is more robust than
  // matching both spellings everywhere.
  removeNSPrefix: true,
  parseAttributeValue: false,
  trimValues: true,
})

type TocEntry = {
  label: string
  /** Path relative to the zip root. */
  file: string
  /** Fragment id, when the entry points inside a document. */
  anchor: string | null
  /** 0 = chapter, 1+ = section nested under the preceding chapter. */
  depth: number
}

export async function parseEpub(data: Buffer | Uint8Array | ArrayBuffer): Promise<ParsedBook> {
  const zip = await JSZip.loadAsync(data)

  const opfPath = await findOpfPath(zip)
  const opfRaw = await readText(zip, opfPath)
  if (opfRaw === null) throw new Error(`EPUB: OPF declared at "${opfPath}" is missing from the archive`)
  const opf = parser.parse(opfRaw)
  const pkg = opf.package
  if (!pkg) throw new Error('EPUB: package element missing from OPF')

  const base = dirname(opfPath)
  const manifest = buildManifest(pkg.manifest?.item)
  const spine = asArray(pkg.spine?.itemref)
    .map((r) => String(r['@_idref'] ?? ''))
    .filter(Boolean)

  const meta = readMetadata(pkg.metadata)

  /* ---- read spine documents in order, tracking global offsets ---- */

  const parts: string[] = []
  /** zip path -> offset of that document's text within the joined text */
  const docOffset = new Map<string, number>()
  /** zip path -> (anchor id -> offset within that document) */
  const docAnchors = new Map<string, Record<string, number>>()
  let total = 0

  for (const idref of spine) {
    if (SKIP_SPINE_IDS.has(idref)) continue
    const item = manifest.get(idref)
    if (!item) continue
    if (!/xhtml|html|xml/.test(item.mediaType)) continue

    const path = resolve(base, item.href)
    const raw = await readText(zip, path)
    if (raw === null) continue

    const { text, anchors } = extractXhtmlText(raw)
    const cleaned = stripGutenbergBoilerplate(text)
    // A spine item that was pure boilerplate (or pure navigation) contributes
    // nothing; including it would create an empty span in the structure map.
    if (cleaned.length < 40) continue

    // Offsets shift if boilerplate was removed from the front of this document.
    const shift = text.length === cleaned.length ? 0 : text.indexOf(cleaned)
    const adjusted: Record<string, number> = {}
    for (const [id, off] of Object.entries(anchors)) {
      const a = off - (shift > 0 ? shift : 0)
      adjusted[id] = Math.max(0, Math.min(a, cleaned.length))
    }

    docOffset.set(path, total)
    docAnchors.set(path, adjusted)
    parts.push(cleaned)
    total += cleaned.length + 2 // the "\n\n" join below
  }

  const text = parts.join('\n\n')
  if (!text.trim()) throw new Error('EPUB: no readable text found in spine')

  /* ---- table of contents -> chapter/section spans ---- */

  const toc = await readToc(zip, base, pkg, manifest)
  const structure = buildStructure(toc, text, docOffset, docAnchors)

  return { text, structure, meta, hasPages: false }
}

/* ------------------------------------------------------------------ */

async function findOpfPath(zip: JSZip): Promise<string> {
  const container = await readText(zip, 'META-INF/container.xml')
  if (container) {
    const parsed = parser.parse(container)
    const rootfiles = asArray(parsed?.container?.rootfiles?.rootfile)
    const full = rootfiles.find((r) => r['@_full-path'])?.['@_full-path']
    if (full) return String(full)
  }
  // Malformed archives do exist; fall back to the first .opf anywhere.
  const found = Object.keys(zip.files).find((f) => f.toLowerCase().endsWith('.opf'))
  if (!found) throw new Error('EPUB: no OPF found (not a valid EPUB?)')
  return found
}

type ManifestItem = { href: string; mediaType: string; properties: string }

function buildManifest(items: unknown): Map<string, ManifestItem> {
  const out = new Map<string, ManifestItem>()
  for (const it of asArray(items)) {
    const id = String(it['@_id'] ?? '')
    const href = String(it['@_href'] ?? '')
    if (!id || !href) continue
    out.set(id, {
      href: decodeURIComponent(href),
      mediaType: String(it['@_media-type'] ?? ''),
      properties: String(it['@_properties'] ?? ''),
    })
  }
  return out
}

function readMetadata(metadata: Record<string, unknown> | undefined): ParsedBook['meta'] {
  if (!metadata) return {}
  const first = (v: unknown): string | undefined => {
    const a = asArray(v)[0]
    if (a === undefined) return undefined
    if (typeof a === 'string' || typeof a === 'number') return String(a)
    const text = (a as Record<string, unknown>)['#text']
    return text === undefined ? undefined : String(text)
  }

  // Gutenberg writes dc:creator as "Emperor of Rome Marcus Aurelius" and the
  // sortable form in a refining meta. Prefer the latter when present — though
  // the pipeline uses Open Library / Gutendex for display metadata anyway, and
  // this only backs up a private upload with no catalog match.
  let author = first(metadata.creator)
  const metas = asArray(metadata.meta)
  const fileAs = metas.find((m) => String(m['@_property'] ?? '') === 'file-as')
  if (fileAs?.['#text']) author = String(fileAs['#text'])

  return {
    title: first(metadata.title),
    author,
    language: first(metadata.language),
    publisher: first(metadata.publisher),
    date: first(metadata.date),
    rights: first(metadata.rights),
  }
}

async function readToc(
  zip: JSZip,
  base: string,
  pkg: Record<string, any>,
  manifest: Map<string, ManifestItem>,
): Promise<TocEntry[]> {
  // EPUB 3 nav document first — it is the normative one.
  for (const [, item] of manifest) {
    if (item.properties.split(/\s+/).includes('nav')) {
      const path = resolve(base, item.href)
      const raw = await readText(zip, path)
      if (raw) {
        const entries = parseNavDoc(raw, dirname(path))
        if (entries.length) return entries
      }
    }
  }

  // EPUB 2 NCX, addressed by spine[@toc].
  const tocId = String(pkg.spine?.['@_toc'] ?? '')
  const candidates = tocId ? [tocId] : []
  for (const [id, item] of manifest) {
    if (item.mediaType.includes('dtbncx')) candidates.push(id)
  }
  for (const id of candidates) {
    const item = manifest.get(id)
    if (!item) continue
    const path = resolve(base, item.href)
    const raw = await readText(zip, path)
    if (raw) {
      const entries = parseNcx(raw, dirname(path))
      if (entries.length) return entries
    }
  }

  return []
}

function parseNcx(raw: string, base: string): TocEntry[] {
  const doc = parser.parse(raw)
  const out: TocEntry[] = []

  const walk = (points: unknown, depth: number) => {
    for (const p of asArray(points)) {
      const label = cleanLabel(deepText(p.navLabel?.text))
      const src = String(p.content?.['@_src'] ?? '')
      if (label && src) out.push(toEntry(label, src, base, depth))
      if (p.navPoint) walk(p.navPoint, depth + 1)
    }
  }

  walk(doc?.ncx?.navMap?.navPoint, 0)
  return out
}

function parseNavDoc(raw: string, base: string): TocEntry[] {
  // The nav document is XHTML; find the toc nav, then walk its nested lists.
  const navMatch = /<nav\b[^>]*epub:type\s*=\s*["'][^"']*\btoc\b[^"']*["'][^>]*>([\s\S]*?)<\/nav>/i.exec(raw)
  const body = navMatch?.[1] ?? /<nav\b[^>]*>([\s\S]*?)<\/nav>/i.exec(raw)?.[1]
  if (!body) return []

  const out: TocEntry[] = []
  // Depth from <ol> nesting; anchors in document order.
  const token = /<(\/?)(ol|a)\b([^>]*)>/gi
  let depth = -1
  let m: RegExpExecArray | null
  while ((m = token.exec(body)) !== null) {
    const [, closing, tag, attrs] = m
    if (tag.toLowerCase() === 'ol') {
      depth += closing ? -1 : 1
      continue
    }
    if (closing) continue
    const href = /\bhref\s*=\s*("([^"]*)"|'([^']*)')/i.exec(attrs)
    if (!href) continue
    // Label is the anchor's text content.
    const close = body.indexOf('</a>', token.lastIndex)
    const inner = close === -1 ? '' : body.slice(token.lastIndex, close)
    const label = cleanLabel(inner.replace(/<[^>]+>/g, ' '))
    const src = href[2] ?? href[3] ?? ''
    if (label && src) out.push(toEntry(label, src, base, Math.max(0, depth)))
  }
  return out
}

function toEntry(label: string, src: string, base: string, depth: number): TocEntry {
  const [rawFile, anchor] = src.split('#')
  return {
    label,
    file: resolve(base, decodeURIComponent(rawFile)),
    anchor: anchor || null,
    depth,
  }
}

/**
 * Turn flat TOC entries into ordered, non-overlapping spans covering the whole
 * text. Entries are sorted by resolved offset rather than trusted in TOC order:
 * some publishers list front matter out of reading order, which would otherwise
 * produce negative-length spans.
 */
function buildStructure(
  toc: TocEntry[],
  text: string,
  docOffset: Map<string, number>,
  docAnchors: Map<string, Record<string, number>>,
): StructureEntry[] {
  type Located = { label: string; depth: number; offset: number }
  const located: Located[] = []

  for (const e of toc) {
    const docStart = docOffset.get(e.file)
    if (docStart === undefined) continue // skipped spine item (cover, boilerplate)
    const within = e.anchor ? (docAnchors.get(e.file)?.[e.anchor] ?? 0) : 0
    located.push({ label: e.label, depth: e.depth, offset: docStart + within })
  }

  located.sort((a, b) => a.offset - b.offset || a.depth - b.depth)

  if (!located.length) {
    return [{ chapter: null, section: null, start: 0, end: text.length, pageStart: null }]
  }

  const out: StructureEntry[] = []
  let chapter: string | null = null

  // Text before the first TOC entry still needs a home.
  if (located[0].offset > 0) {
    out.push({ chapter: null, section: null, start: 0, end: located[0].offset, pageStart: null })
  }

  for (let i = 0; i < located.length; i++) {
    const cur = located[i]
    const start = cur.offset
    const end = i + 1 < located.length ? located[i + 1].offset : text.length
    if (end <= start) continue // duplicate anchors pointing at the same spot

    if (cur.depth === 0) chapter = cur.label

    out.push({
      chapter: cur.depth === 0 ? cur.label : chapter,
      section: cur.depth === 0 ? null : cur.label,
      start,
      end,
      pageStart: null,
    })
  }

  return out
}

/* ------------------------------------------------------------------ */

function cleanLabel(s: unknown): string {
  const raw = typeof s === 'string' ? s : s === undefined || s === null ? '' : String(s)
  return raw.replace(/\s+/g, ' ').trim()
}

/** navLabel/text can be a string, or an object when attributes are present. */
function deepText(v: unknown): string {
  if (v === undefined || v === null) return ''
  if (typeof v === 'string' || typeof v === 'number') return String(v)
  if (Array.isArray(v)) return v.map(deepText).join(' ')
  const o = v as Record<string, unknown>
  if ('#text' in o) return deepText(o['#text'])
  return ''
}

function asArray(v: unknown): Record<string, any>[] {
  if (v === undefined || v === null) return []
  return (Array.isArray(v) ? v : [v]) as Record<string, any>[]
}

async function readText(zip: JSZip, path: string): Promise<string | null> {
  const file = zip.file(path) ?? zip.file(path.replace(/^\/+/, ''))
  if (!file) return null
  return file.async('string')
}

function dirname(path: string): string {
  const i = path.lastIndexOf('/')
  return i === -1 ? '' : path.slice(0, i)
}

function resolve(base: string, href: string): string {
  if (!base) return normalizePath(href)
  if (href.startsWith('/')) return normalizePath(href.slice(1))
  return normalizePath(`${base}/${href}`)
}

function normalizePath(path: string): string {
  const parts: string[] = []
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') parts.pop()
    else parts.push(seg)
  }
  return parts.join('/')
}
