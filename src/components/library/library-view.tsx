'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'

import type { LibraryRow } from '@/lib/library'

import { UploadDialog } from './upload-dialog'

type SearchResult = {
  id: string
  title: string
  author: string
  yearWritten: string | null
  coverUrl: string | null
  editionCount: number
  inLibrary: boolean
}

type Tab = 'mine' | 'add'

export function LibraryView({
  initialBooks,
  initialTab,
  initialQuery,
}: {
  initialBooks: LibraryRow[]
  initialTab: Tab
  initialQuery: string
}) {
  const router = useRouter()
  const [tab, setTab] = useState<Tab>(initialTab)
  const [shelf, setShelf] = useState(initialBooks)
  // One query per tab. Sharing a single value meant typing a filter in My
  // books silently became an Open Library search when you switched tabs, and
  // vice versa — two different jobs that happen to both use a text box.
  // initialQuery seeds the SHELF filter: it arrives from the passage drawer's
  // "View in library" link, which is about a book you already own.
  const [shelfQuery, setShelfQuery] = useState(initialQuery)
  const [searchQuery, setSearchQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [uploadFor, setUploadFor] = useState<LibraryRow | null>(null)
  const [added, setAdded] = useState<string | null>(null)

  const indexing = shelf.some(
    (b) =>
      b.indexStatus === 'pending' || b.indexStatus === 'parsing' || b.indexStatus === 'embedding',
  )

  // Poll only while something is actually indexing.
  useEffect(() => {
    if (!indexing) return
    const t = setInterval(async () => {
      const res = await fetch('/api/library')
      if (res.ok) setShelf((await res.json()).books)
    }, 2500)
    return () => clearInterval(t)
  }, [indexing])

  // Debounced Open Library search. Nothing is fetched until there is a real
  // query — there is no catalog to browse, so an empty box means an empty page.
  useEffect(() => {
    if (tab !== 'add') return
    const q = searchQuery.trim()
    setAdded(null)
    if (q.length < 3) {
      setResults([])
      setSearchError(null)
      setSearching(false)
      return
    }

    const controller = new AbortController()
    setSearching(true)
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/catalog?q=${encodeURIComponent(q)}`, {
          signal: controller.signal,
        })
        const data = (await res.json()) as { books?: SearchResult[]; error?: string }
        setResults(data.books ?? [])
        setSearchError(data.error ?? null)
      } catch (err) {
        if ((err as Error).name !== 'AbortError') setSearchError('Search failed.')
      } finally {
        setSearching(false)
      }
    }, 350)

    return () => {
      clearTimeout(t)
      controller.abort()
    }
  }, [tab, searchQuery])

  async function add(bookId: string) {
    setPending(bookId)
    try {
      const res = await fetch('/api/library', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bookId }),
      })
      const data = (await res.json()) as {
        error?: string
        status?: 'ready' | 'needs_file'
        indexing?: boolean
      }
      if (!res.ok) {
        setSearchError(data.error ?? 'Could not add that book.')
        return
      }

      // Whether we could supply the text is only known now, after the
      // Gutenberg lookup — so say which of the two happened rather than
      // leaving the user to guess from the shelf.
      setAdded(
        data.status === 'needs_file'
          ? 'Added — still in copyright, so upload your own DRM-free EPUB from My books.'
          : data.indexing
            ? 'Added — public domain, reading it now. It becomes searchable in a few minutes.'
            : 'Added — public domain and already indexed. Ask away.',
      )
      await reloadShelf()
      setResults((prev) => prev.map((b) => (b.id === bookId ? { ...b, inLibrary: true } : b)))
    } finally {
      setPending(null)
    }
  }

  async function reloadShelf() {
    const res = await fetch('/api/library')
    if (res.ok) setShelf((await res.json()).books)
    router.refresh()
  }

  async function remove(editionId: string) {
    setPending(editionId)
    try {
      await fetch('/api/library', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ editionId }),
      })
      setShelf((prev) => prev.filter((b) => b.editionId !== editionId))
      router.refresh()
    } finally {
      setPending(null)
    }
  }

  async function toggle(editionId: string, selected: boolean) {
    setShelf((prev) => prev.map((b) => (b.editionId === editionId ? { ...b, selected } : b)))
    await fetch('/api/library', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ editionId, selected }),
    })
    router.refresh()
  }

  const filteredShelf = useMemo(() => {
    const q = shelfQuery.trim().toLowerCase()
    if (!q) return shelf
    return shelf.filter(
      (b) => b.title.toLowerCase().includes(q) || b.author.toLowerCase().includes(q),
    )
  }, [shelf, shelfQuery])

  const needsFile = shelf.filter((b) => b.status === 'needs_file')
  const trimmedSearch = searchQuery.trim()

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[860px] flex-col gap-5 px-5 py-7">
      <div className="flex items-center gap-1 border-b border-line">
        {(
          [
            ['mine', `My books${shelf.length ? ` (${shelf.length})` : ''}`],
            ['add', 'Add books'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`-mb-px border-b-2 px-3 pb-2.5 pt-1 text-sm font-semibold transition-colors ${
              tab === key ? 'border-accent text-ink' : 'border-transparent text-muted hover:text-ink'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'mine' ? (
        <input
          key="shelf-filter"
          value={shelfQuery}
          onChange={(e) => setShelfQuery(e.target.value)}
          placeholder="Filter your books"
          className="h-12 rounded-md border border-line-input bg-surface px-3.5 text-[15px] outline-none focus:border-accent"
        />
      ) : (
        <input
          key="catalog-search"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search any book by title or author"
          autoFocus
          className="h-12 rounded-md border border-line-input bg-surface px-3.5 text-[15px] outline-none focus:border-accent"
        />
      )}

      {tab === 'mine' && needsFile.length > 0 && (
        <div className="rounded-md border border-warn-fg/20 bg-warn-bg px-4 py-3 text-sm leading-relaxed text-warn-fg">
          <b>
            {needsFile.length} {needsFile.length === 1 ? 'book needs' : 'books need'} a file
          </b>{' '}
          before they can be searched. Use <b>Upload</b> on each one.
        </div>
      )}

      {tab === 'mine' ? (
        <div className="flex flex-col gap-2">
          {filteredShelf.length === 0 && (
            <div className="flex flex-col items-start gap-3 rounded-md border border-line bg-surface px-4 py-6">
              <p className="m-0 text-[15px] text-muted">
                {shelf.length === 0 ? 'No books yet.' : 'Nothing matches that filter.'}
              </p>
              {shelf.length === 0 && (
                <button
                  type="button"
                  onClick={() => setTab('add')}
                  className="h-10 rounded-md bg-accent px-4 text-sm font-semibold text-surface"
                >
                  Find a book
                </button>
              )}
            </div>
          )}
          {filteredShelf.map((b) => (
            <ShelfRow
              key={b.editionId}
              book={b}
              busy={pending === b.editionId}
              onRemove={() => remove(b.editionId)}
              onToggle={(v) => toggle(b.editionId, v)}
              onUpload={() => setUploadFor(b)}
            />
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {added && (
            <p className="m-0 rounded-md border border-ok-fg/20 bg-ok-bg p-3 text-sm leading-relaxed text-ok-fg">
              {added}
            </p>
          )}
          {searchError && (
            <p className="m-0 rounded-md border border-accent/25 bg-accent-soft p-3 text-sm text-accent">
              {searchError}
            </p>
          )}

          {trimmedSearch.length < 3 ? (
            <div className="flex flex-col gap-2 rounded-md border border-line bg-surface px-4 py-6">
              <p className="m-0 text-[15px] text-muted">
                Search for any book by title or author.
              </p>
              <p className="m-0 text-[13px] leading-relaxed text-faint">
                Out-of-copyright books are added with their full text straight away. Anything still
                in copyright needs your own DRM-free EPUB — we can&apos;t supply the words.
              </p>
            </div>
          ) : searching && results.length === 0 ? (
            <p className="m-0 px-1 py-6 text-[15px] text-muted">Searching Open Library…</p>
          ) : results.length === 0 ? (
            <p className="m-0 px-1 py-6 text-[15px] text-muted">
              Nothing found for &ldquo;{trimmedSearch}&rdquo;. Try the author&apos;s surname.
            </p>
          ) : (
            results.map((b) => (
              <ResultRow key={b.id} book={b} busy={pending === b.id} onAdd={() => add(b.id)} />
            ))
          )}
        </div>
      )}

        <UploadDialog book={uploadFor} onClose={() => setUploadFor(null)} onDone={reloadShelf} />
      </div>
    </div>
  )
}

/**
 * Spine colour derived from the title.
 *
 * The curated catalog used to carry a hand-picked colour per book. Open Library
 * supplies none, so a stable hash keeps the shelf looking like a shelf instead
 * of a column of identical grey blocks.
 */
function spineColor(seed: string): string {
  const palette = [
    '#7B2632', '#3F4F44', '#5B4A3A', '#2F4058', '#56603A', '#6B5B2E',
    '#3B2F3F', '#8A3B22', '#344A4E', '#5E3A2E', '#2E3A34', '#4A3550',
    '#3D5160', '#6E2B2B', '#4F4430', '#33424F',
  ]
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0
  return palette[h % palette.length]
}

function Cover({ url, seed }: { url: string | null; seed: string }) {
  if (url) {
    // Hotlinked from Open Library's CDN. Cover art is copyrighted even when the
    // book is public domain, so we never hold a copy.
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={url} alt="" className="h-14 w-10 shrink-0 rounded-sm object-cover" />
  }
  return (
    <span
      aria-hidden
      className="h-14 w-10 shrink-0 rounded-sm"
      style={{ background: spineColor(seed) }}
    />
  )
}

function ShelfRow({
  book,
  busy,
  onRemove,
  onToggle,
  onUpload,
}: {
  book: LibraryRow
  busy: boolean
  onRemove: () => void
  onToggle: (selected: boolean) => void
  onUpload: () => void
}) {
  const working =
    book.indexStatus === 'pending' ||
    book.indexStatus === 'parsing' ||
    book.indexStatus === 'embedding'

  return (
    <div className="flex items-center gap-3 rounded-md border border-line bg-surface px-3 py-2.5">
      <Cover url={book.coverUrl} seed={book.bookId} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[15px] font-semibold">{book.title}</div>
        <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-muted-2">
          <span className="truncate">
            {book.author} · {book.edition || (book.isPd ? 'Public domain' : 'Your copy')}
          </span>
          <StatusPill book={book} />
        </div>
        {working && (
          <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-line">
            <div
              className="h-full rounded-full bg-accent transition-[width] duration-500"
              style={{ width: `${Math.max(3, book.progress)}%` }}
            />
          </div>
        )}
        {book.indexStatus === 'failed' && book.error && (
          <div className="mt-1 text-[12px] text-accent">{book.error.slice(0, 160)}</div>
        )}
      </div>

      {(book.indexStatus === 'awaiting_file' || book.indexStatus === 'failed') && (
        <button
          type="button"
          onClick={onUpload}
          className="h-9 shrink-0 rounded-md bg-ink px-3 text-[13px] font-semibold text-surface transition-colors hover:bg-accent"
        >
          {book.indexStatus === 'failed' ? 'Retry' : 'Upload'}
        </button>
      )}

      <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-[12.5px] text-muted-2">
        <input
          type="checkbox"
          checked={book.selected}
          onChange={(e) => onToggle(e.target.checked)}
          className="accent-[var(--color-accent)]"
        />
        Search
      </label>

      <button
        type="button"
        onClick={onRemove}
        disabled={busy}
        aria-label={`Remove ${book.title}`}
        className="grid h-8 w-8 shrink-0 place-items-center rounded text-lg text-faint hover:bg-hover hover:text-accent disabled:opacity-40"
      >
        ×
      </button>
    </div>
  )
}

function StatusPill({ book }: { book: LibraryRow }) {
  const [label, cls] =
    book.indexStatus === 'ready'
      ? (['Searchable', 'bg-ok-bg text-ok-fg'] as const)
      : book.indexStatus === 'failed'
        ? (['Failed', 'bg-accent-soft text-accent'] as const)
        : book.indexStatus === 'awaiting_file'
          ? (['Needs file', 'bg-warn-bg text-warn-fg'] as const)
          : ([`Indexing ${book.progress}%`, 'bg-warn-bg text-warn-fg'] as const)

  return (
    <span className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] font-semibold ${cls}`}>
      {label}
    </span>
  )
}

function ResultRow({
  book,
  busy,
  onAdd,
}: {
  book: SearchResult
  busy: boolean
  onAdd: () => void
}) {
  return (
    <div className="flex items-center gap-3 rounded-md border border-line bg-surface px-3 py-2.5">
      <Cover url={book.coverUrl} seed={book.id} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[15px] font-semibold">{book.title}</div>
        <div className="truncate text-[12.5px] text-muted-2">
          {book.author}
          {book.yearWritten ? ` · ${book.yearWritten}` : ''}
        </div>
      </div>
      <button
        type="button"
        onClick={onAdd}
        disabled={busy || book.inLibrary}
        className="h-9 shrink-0 rounded-md bg-ink px-3.5 text-[13px] font-semibold text-surface transition-colors hover:bg-accent disabled:bg-transparent disabled:text-ok-fg"
      >
        {book.inLibrary ? 'Added ✓' : busy ? 'Adding…' : 'Add'}
      </button>
    </div>
  )
}
