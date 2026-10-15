'use client'

import { useRef, useState } from 'react'

import type { LibraryRow } from '@/lib/library'

/**
 * Upload your own copy of a book.
 *
 * The attestation checkbox is not decoration. The defensible version of this
 * product is "each reader supplies their own lawful copy", and DRM removal is
 * a separate violation from copying that fair use does not excuse. Asking
 * plainly, once, is what puts that representation on record — and the server
 * rejects the upload without it.
 */
export function UploadDialog({
  book,
  onClose,
  onDone,
}: {
  book: LibraryRow | null
  onClose: () => void
  onDone: () => void
}) {
  const [attested, setAttested] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [filename, setFilename] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  if (!book) return null

  async function upload() {
    const file = inputRef.current?.files?.[0]
    if (!file) {
      setError('Choose a file first.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const body = new FormData()
      body.set('editionId', book!.editionId)
      body.set('attested', String(attested))
      body.set('file', file)

      const res = await fetch('/api/upload', { method: 'POST', body })
      const data = (await res.json()) as { error?: string }
      if (!res.ok) {
        setError(data.error ?? 'Upload failed.')
        return
      }
      onDone()
      onClose()
    } catch {
      setError('Upload failed — is the file still there?')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="fixed inset-0 z-40 bg-ink/30"
      />
      <div
        role="dialog"
        aria-modal="true"
        className="fixed left-1/2 top-1/2 z-50 flex w-[min(92vw,460px)] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 rounded-xl border border-line bg-surface p-5 shadow-[0_32px_64px_-24px_rgba(34,28,24,0.4)]"
      >
        <div className="flex flex-col gap-1">
          <div className="eyebrow">Upload your copy</div>
          <h2 className="m-0 font-serif text-[22px] leading-tight">{book.title}</h2>
          <p className="m-0 text-[13px] text-muted">{book.author}</p>
        </div>

        <p className="m-0 text-[13.5px] leading-relaxed text-muted">
          This book is under copyright, so we can&apos;t supply the text. Upload your own copy and
          it becomes searchable for your account only — never shared with anyone else.
        </p>

        <input
          ref={inputRef}
          type="file"
          accept=".epub,.txt,application/epub+zip,text/plain"
          onChange={(e) => {
            setFilename(e.target.files?.[0]?.name ?? null)
            setError(null)
          }}
          className="text-[13px] file:mr-3 file:h-9 file:cursor-pointer file:rounded-md file:border file:border-line-strong file:bg-paper file:px-3 file:text-[13px] file:font-semibold"
        />
        {filename && <p className="m-0 text-[12.5px] text-muted-2">{filename}</p>}

        <label className="flex cursor-pointer items-start gap-2.5 text-[13px] leading-relaxed">
          <input
            type="checkbox"
            checked={attested}
            onChange={(e) => setAttested(e.target.checked)}
            className="mt-0.5 accent-[var(--color-accent)]"
          />
          <span>
            I own a lawful copy of this book and this file is <b>DRM-free</b>. I did not remove
            copy protection to create it.
          </span>
        </label>

        {error && (
          <p className="m-0 rounded-md border border-accent/25 bg-accent-soft p-2.5 text-[13px] text-accent">
            {error}
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={upload}
            disabled={busy || !attested}
            className="h-10 flex-1 rounded-md bg-accent px-4 text-sm font-semibold text-surface transition-colors hover:bg-accent-hover disabled:bg-line-strong"
          >
            {busy ? 'Uploading…' : 'Upload and index'}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="h-10 rounded-md border border-line-strong px-4 text-sm font-semibold text-ink"
          >
            Cancel
          </button>
        </div>

        <p className="m-0 text-[12px] leading-relaxed text-faint">
          EPUB or plain text. The file is deleted once indexed — only the passages are kept, so
          answers can quote and cite them.
        </p>
      </div>
    </>
  )
}
