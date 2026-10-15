import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'

import { auth } from '@/auth'
import { db, editions } from '@/db'
import { env } from '@/lib/env'

/**
 * Upload the user's own copy of a book.
 *
 * The file lands on disk, the edition flips to 'pending', and the worker picks
 * it up — the route does no parsing or embedding, because indexing a 500-page
 * book takes minutes and must not occupy a request.
 *
 * Three things are deliberate:
 *
 * 1. Ownership is re-checked against the database. The editionId arrives over
 *    HTTP, so being able to name one proves nothing.
 * 2. The DRM-free attestation is required, not decorative. Stripping DRM is a
 *    separate violation from copying (DMCA §1201 in the US), and fair use is
 *    not a defence to it. The app must never be the thing that assists it.
 * 3. Files are written under a per-user directory keyed by content hash, never
 *    a shared pool. Private editions are never deduplicated across accounts.
 */

/** Default when the admin setting is absent; overridden per-request below. */
const DEFAULT_MAX_MB = 100

const ACCEPTED: Record<string, 'epub' | 'pdf' | 'txt'> = {
  'application/epub+zip': 'epub',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
}

function formatFromName(name: string): 'epub' | 'pdf' | 'txt' | null {
  const lower = name.toLowerCase()
  if (lower.endsWith('.epub')) return 'epub'
  if (lower.endsWith('.pdf')) return 'pdf'
  if (lower.endsWith('.txt')) return 'txt'
  return null
}

export async function POST(req: Request) {
  const session = await auth()
  const userId = session?.user?.id
  if (!userId) return new Response('Unauthorized', { status: 401 })

  const form = await req.formData()
  const editionId = String(form.get('editionId') ?? '')
  const attested = form.get('attested') === 'true'
  const file = form.get('file')

  if (!editionId) return Response.json({ error: 'editionId required' }, { status: 400 })
  if (!(file instanceof File)) return Response.json({ error: 'file required' }, { status: 400 })

  if (!attested) {
    return Response.json(
      { error: 'Confirm you own a lawful, DRM-free copy of this book.' },
      { status: 400 },
    )
  }

  const edition = await db.query.editions.findFirst({
    where: (e, { eq: is }) => is(e.id, editionId),
  })
  if (!edition || edition.kind !== 'private' || edition.ownerUserId !== userId) {
    // Same answer whether it does not exist or belongs to someone else.
    return Response.json({ error: 'No such book awaiting a file.' }, { status: 404 })
  }

  if (file.size === 0) return Response.json({ error: 'That file is empty.' }, { status: 400 })

  const { getSettings } = await import('@/lib/admin/data')
  const maxMb = Number((await getSettings()).max_upload_mb) || DEFAULT_MAX_MB
  if (file.size > maxMb * 1024 * 1024) {
    return Response.json(
      { error: `That file is ${(file.size / 1e6).toFixed(0)}MB; the limit is ${maxMb}MB.` },
      { status: 413 },
    )
  }

  // Extension wins over the browser-supplied MIME type, which is frequently
  // application/octet-stream for EPUBs.
  const format = formatFromName(file.name) ?? ACCEPTED[file.type] ?? null
  if (!format) {
    return Response.json(
      { error: 'Only EPUB, PDF or plain text files can be indexed.' },
      { status: 415 },
    )
  }
  if (format === 'pdf') {
    return Response.json(
      { error: 'PDF support is not finished yet — EPUB works today.' },
      { status: 415 },
    )
  }

  const bytes = Buffer.from(await file.arrayBuffer())
  const fileHash = createHash('sha256').update(bytes).digest('hex')

  // Per-user directory. resolve() guards against a crafted id escaping it.
  const baseDir = resolve(env.uploadDir)
  const userDir = join(baseDir, userId.replace(/[^a-zA-Z0-9_-]/g, '_'))
  const path = join(userDir, `${fileHash}.${format}`)
  if (!path.startsWith(baseDir)) {
    return Response.json({ error: 'Invalid path.' }, { status: 400 })
  }

  await mkdir(userDir, { recursive: true })
  await writeFile(path, bytes)

  // 'pending' is the state the worker claims. Writing the file first means a
  // crash between the two leaves an orphan file, which is harmless — the
  // reverse would leave the worker chasing a file that does not exist.
  await db
    .update(editions)
    .set({
      sourceRef: path,
      fileFormat: format,
      indexStatus: 'pending',
      progress: 0,
      error: null,
    })
    .where(eq(editions.id, editionId))

  return Response.json({ ok: true, format, bytes: file.size })
}
