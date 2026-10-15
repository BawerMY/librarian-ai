import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * Project Gutenberg, addressed directly.
 *
 * Gutendex (the community JSON API) is convenient but has no SLA — it answered
 * 503 during development and intermittently returns empty result sets. It is
 * therefore NOT in any critical path: the catalog is seeded from Gutenberg's
 * own catalog CSV, and text is fetched from a URL built from the book id.
 *
 * Rights are verified from the EPUB's own dc:rights rather than a metadata API,
 * which means the single download that gives us the text also proves we are
 * allowed to host it. See assertPublicDomain().
 */

const CATALOG_URL = 'https://www.gutenberg.org/cache/epub/feeds/pg_catalog.csv'
const CACHE_PATH = './.data/pg_catalog.csv'
const CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

export type CatalogEntry = {
  id: number
  title: string
  /** "Marcus Aurelius, Emperor of Rome, 121-180" — surname-first, as published. */
  authors: string
  language: string
  subjects: string[]
  bookshelves: string[]
  /** Library of Congress class letter(s): "B" philosophy, "HB" economics. */
  locc: string
}

/** EPUB3 with images, the variant that carries a usable spine and TOC. */
export function epubUrl(gutenbergId: number): string {
  return `https://www.gutenberg.org/ebooks/${gutenbergId}.epub3.images`
}

export function plainTextUrl(gutenbergId: number): string {
  return `https://www.gutenberg.org/ebooks/${gutenbergId}.txt.utf-8`
}

export async function download(url: string): Promise<Buffer> {
  const res = await withRetry(() => fetch(url, { redirect: 'follow' }))
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${url}`)
  return Buffer.from(await res.arrayBuffer())
}

/**
 * A public edition is text WE host and serve to every user — the one place in
 * this system where we are the distributor rather than the host of someone
 * else's upload. So the rights statement has to positively assert public
 * domain; absent or ambiguous is a refusal, not a shrug.
 */
export function assertPublicDomain(rights: string | undefined, label: string): void {
  if (!rights) {
    throw new Error(
      `${label}: EPUB declares no dc:rights. Refusing to create a public edition without a positive public-domain statement.`,
    )
  }
  if (!/public domain/i.test(rights)) {
    throw new Error(`${label}: dc:rights is "${rights}" — not a public-domain statement.`)
  }
}

/* ------------------------------------------------------------------ *
 * Catalog — 90k rows, ~21MB. Downloaded once and cached on disk.
 * ------------------------------------------------------------------ */

export async function loadCatalog(opts: { refresh?: boolean } = {}): Promise<CatalogEntry[]> {
  const csv = await readCatalogCsv(opts.refresh ?? false)
  return parseCatalog(csv)
}

async function readCatalogCsv(refresh: boolean): Promise<string> {
  if (!refresh) {
    try {
      const info = await stat(CACHE_PATH)
      if (Date.now() - info.mtimeMs < CACHE_MAX_AGE_MS) {
        return readFile(CACHE_PATH, 'utf8')
      }
    } catch {
      // not cached yet
    }
  }

  const res = await withRetry(() => fetch(CATALOG_URL, { redirect: 'follow' }))
  if (!res.ok) throw new Error(`Gutenberg catalog download failed: ${res.status}`)
  const csv = await res.text()

  await mkdir(dirname(CACHE_PATH), { recursive: true })
  await writeFile(CACHE_PATH, csv, 'utf8')
  return csv
}

/**
 * Columns: Text#,Type,Issued,Title,Language,Authors,Subjects,LoCC,Bookshelves
 *
 * Only English `Text` rows are kept — audio and non-English entries would
 * index to noise under an English-only embedding model, and the model has no
 * way to signal that it happened.
 */
export function parseCatalog(csv: string): CatalogEntry[] {
  const rows = parseCsv(csv)
  const header = rows.shift()
  if (!header) return []

  const col = (name: string) => header.indexOf(name)
  const iId = col('Text#')
  const iType = col('Type')
  const iTitle = col('Title')
  const iLang = col('Language')
  const iAuthors = col('Authors')
  const iSubjects = col('Subjects')
  const iLocc = col('LoCC')
  const iShelves = col('Bookshelves')

  const out: CatalogEntry[] = []
  for (const r of rows) {
    if (r[iType] !== 'Text') continue
    if (r[iLang] !== 'en') continue
    const id = Number(r[iId])
    if (!Number.isInteger(id)) continue

    out.push({
      id,
      // Titles contain embedded newlines in the CSV ("On the Origin of
      // Species\r\nOr, the Preservation…").
      title: (r[iTitle] ?? '').replace(/\s+/g, ' ').trim(),
      authors: (r[iAuthors] ?? '').replace(/\s+/g, ' ').trim(),
      language: r[iLang] ?? 'en',
      subjects: splitList(r[iSubjects]),
      bookshelves: splitList(r[iShelves]),
      locc: r[iLocc] ?? '',
    })
  }
  return out
}

function splitList(v: string | undefined): string[] {
  if (!v) return []
  return v
    .split(';')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
}

/**
 * Find the best Gutenberg match for a catalog title + author.
 *
 * Scored rather than first-match: searching "Meditations" by title alone
 * returns dozens of unrelated devotional works, and picking the wrong one
 * would silently attach the wrong text to a catalog entry — a book whose
 * citations all point at another author's words.
 */
export function matchBook(
  catalog: CatalogEntry[],
  title: string,
  authorSurname: string,
): CatalogEntry | null {
  const wantTitle = norm(title)
  const wantAuthor = norm(authorSurname)

  let best: { entry: CatalogEntry; score: number } | null = null

  for (const e of catalog) {
    const haveTitle = norm(e.title)
    const haveAuthor = norm(e.authors)

    if (!haveAuthor.includes(wantAuthor)) continue

    let score = 0
    if (haveTitle === wantTitle) score += 100
    else if (haveTitle.startsWith(wantTitle)) score += 70
    else if (haveTitle.includes(wantTitle)) score += 45
    else continue

    // Prefer complete works over extracts and single volumes.
    if (/\bvol(ume)?\b|\bpart\b|\bselections?\b|\bextracts?\b/.test(haveTitle)) score -= 15
    // Curated shelves are a decent proxy for "the canonical edition".
    if (e.bookshelves.some((s) => /harvard classics|best books ever/i.test(s))) score += 10
    // Shorter titles are usually the main work, not a compilation.
    score -= Math.min(20, Math.floor(haveTitle.length / 12))

    if (!best || score > best.score) best = { entry: e, score }
  }

  return best?.entry ?? null
}

function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/* ------------------------------------------------------------------ */

/** Minimal RFC4180 CSV reader — quoted fields contain commas and newlines. */
function parseCsv(input: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]

    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"'
          i++
        } else {
          quoted = false
        }
      } else {
        field += ch
      }
      continue
    }

    if (ch === '"') quoted = true
    else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\n') {
      row.push(field)
      field = ''
      rows.push(row)
      row = []
    } else if (ch !== '\r') {
      field += ch
    }
  }

  if (field || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

async function withRetry(fn: () => Promise<Response>, attempts = 3): Promise<Response> {
  let lastErr: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fn()
      // 5xx and 429 are transient; 4xx is not worth retrying.
      if (res.status >= 500 || res.status === 429) {
        lastErr = new Error(`HTTP ${res.status}`)
      } else {
        return res
      }
    } catch (err) {
      lastErr = err
    }
    if (i < attempts - 1) await sleep(500 * 2 ** i)
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
