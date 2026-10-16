import type { CitationChip } from '@/lib/ai/tools'

/** An answer caught mid-write, kept across an unmount. */
export type Snapshot = { text: string; citations: Record<string, CitationChip> }

/**
 * The half-written answer, stored outside React.
 *
 * Leaving the chat unmounts the view and aborts the response stream, so the
 * paragraphs already on screen were simply gone on return: you saw an answer
 * forming, switched to the library, came back, and got "Still answering" with
 * nothing under it. Generation never stopped — only the reader did.
 *
 * sessionStorage is the right lifetime for this: per-tab, survives the
 * unmount, and worthless once the real answer lands. It is wrapped in a
 * subscribable store so the view can read it with useSyncExternalStore rather
 * than copying it into state from an effect.
 */
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function key(sessionId: string): string {
  return `librarian:partial:${sessionId}`
}

/** The raw stored string — identity is stable while the entry is unchanged,
 *  which is what lets useSyncExternalStore compare snapshots. */
export function read(storageKey: string): string | null {
  try {
    return window.sessionStorage.getItem(storageKey)
  } catch {
    // Storage disabled or blocked: no snapshot, which renders as the plain
    // "still answering" line. A nicety, not a requirement.
    return null
  }
}

export function save(storageKey: string, snapshot: Snapshot): void {
  try {
    const next = JSON.stringify(snapshot)
    if (window.sessionStorage.getItem(storageKey) === next) return
    window.sessionStorage.setItem(storageKey, next)
    emit()
  } catch {
    // See read().
  }
}

export function clear(storageKey: string): void {
  try {
    if (window.sessionStorage.getItem(storageKey) === null) return
    window.sessionStorage.removeItem(storageKey)
    emit()
  } catch {
    // See read().
  }
}
