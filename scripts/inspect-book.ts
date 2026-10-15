/**
 * Parse a book file and print what the ingest pipeline would see.
 *
 *   pnpm tsx scripts/inspect-book.ts path/to/book.epub [--spans 40] [--at 12345]
 *
 * Exists because structural extraction quality is the thing that decides
 * whether citations are trustworthy, and it is only checkable by eye.
 */
import { readFile } from 'node:fs/promises'
import { config } from 'dotenv'

config({ path: '.env.local', quiet: true })

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}

async function main() {
  const path = process.argv[2]
  if (!path) {
    console.error('usage: tsx scripts/inspect-book.ts <file.epub|file.txt> [--spans N] [--at OFFSET]')
    process.exit(1)
  }

  const { parseEpub } = await import('@/lib/ingest/epub')
  const data = await readFile(path)

  const book = path.toLowerCase().endsWith('.epub')
    ? await parseEpub(data)
    : (() => {
        throw new Error('only .epub supported so far')
      })()

  console.log('metadata')
  for (const [k, v] of Object.entries(book.meta)) {
    if (v) console.log(`  ${k.padEnd(10)} ${v}`)
  }
  console.log(`  ${'chars'.padEnd(10)} ${book.text.length.toLocaleString()}`)
  console.log(`  ${'hasPages'.padEnd(10)} ${book.hasPages}`)
  console.log(`  ${'spans'.padEnd(10)} ${book.structure.length}`)

  const limit = Number(arg('spans') ?? 40)
  console.log(`\nstructure (first ${limit})`)
  console.log(
    `  ${'start'.padStart(8)} ${'len'.padStart(7)}  ${'chapter'.padEnd(32)} section`,
  )
  for (const s of book.structure.slice(0, limit)) {
    const len = s.end - s.start
    console.log(
      `  ${String(s.start).padStart(8)} ${String(len).padStart(7)}  ` +
        `${(s.chapter ?? '—').slice(0, 32).padEnd(32)} ${s.section ?? ''}`,
    )
  }

  // Coverage + ordering checks: silent gaps here become mislabelled citations.
  let covered = 0
  let gaps = 0
  let overlaps = 0
  let prevEnd = 0
  for (const s of book.structure) {
    if (s.start > prevEnd) gaps++
    if (s.start < prevEnd) overlaps++
    covered += Math.max(0, s.end - Math.max(s.start, prevEnd))
    prevEnd = Math.max(prevEnd, s.end)
  }
  const pct = ((covered / book.text.length) * 100).toFixed(1)
  console.log(`\ncoverage ${pct}%  gaps ${gaps}  overlaps ${overlaps}`)

  const at = arg('at')
  if (at !== undefined) {
    const off = Number(at)
    const span = book.structure.find((s) => off >= s.start && off < s.end)
    console.log(`\nat offset ${off}`)
    console.log(`  chapter  ${span?.chapter ?? '—'}`)
    console.log(`  section  ${span?.section ?? '—'}`)
    console.log(`  text     …${book.text.slice(off, off + 260).replace(/\n+/g, ' ')}…`)
  } else {
    console.log(`\nfirst 300 chars\n  ${book.text.slice(0, 300).replace(/\n+/g, ' ')}`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
