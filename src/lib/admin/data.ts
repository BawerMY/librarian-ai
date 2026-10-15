import { count, desc, eq, sql } from 'drizzle-orm'

import { appSettings, books, chatSessions, chunks, db, editions, userLibrary, users } from '@/db'
import { env } from '@/lib/env'
import { MAX_QUOTE_CHARS, MAX_REVEAL_FRACTION } from '@/lib/limits'
import { COLLECTION, qdrant } from '@/lib/qdrant'

/**
 * Read models for the admin panel.
 *
 * None of this goes through lib/retrieval — not allowedEditions, not
 * searchBooks. Those exist to answer "what may THIS user read", and reusing
 * them for an admin would mean a privileged caller flowing into the one
 * function whose entire job is to be unprivileged.
 *
 * Note what is absent: there is no way here to read the TEXT of a user's
 * private book. Counts, status and errors are enough to operate the service,
 * and "the admin can read your uploads" would quietly contradict the privacy
 * claim the app makes in its own settings copy.
 */

export type AdminUser = {
  id: string
  name: string | null
  email: string | null
  createdAt: Date | null
  hasPassword: boolean
  bookCount: number
  privateCount: number
  chunkCount: number
  chatCount: number
}

export async function listUsers(): Promise<AdminUser[]> {
  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      createdAt: users.createdAt,
      passwordHash: users.passwordHash,
    })
    .from(users)
    .orderBy(desc(users.createdAt))

  // One aggregate pass rather than N queries per user.
  const libAgg = await db
    .select({
      userId: userLibrary.userId,
      books: count(userLibrary.editionId),
      privateBooks: sql<number>`count(*) filter (where ${editions.kind} = 'private')::int`,
      chunks: sql<number>`coalesce(sum(${editions.chunkCount}), 0)::int`,
    })
    .from(userLibrary)
    .innerJoin(editions, eq(editions.id, userLibrary.editionId))
    .groupBy(userLibrary.userId)

  const chatAgg = await db
    .select({ userId: chatSessions.userId, chats: count(chatSessions.id) })
    .from(chatSessions)
    .groupBy(chatSessions.userId)

  const lib = new Map(libAgg.map((r) => [r.userId, r]))
  const chats = new Map(chatAgg.map((r) => [r.userId, Number(r.chats)]))

  return rows.map((u) => ({
    id: u.id,
    name: u.name,
    email: u.email,
    createdAt: u.createdAt,
    hasPassword: Boolean(u.passwordHash),
    bookCount: Number(lib.get(u.id)?.books ?? 0),
    privateCount: Number(lib.get(u.id)?.privateBooks ?? 0),
    chunkCount: Number(lib.get(u.id)?.chunks ?? 0),
    chatCount: chats.get(u.id) ?? 0,
  }))
}

export type AdminEdition = {
  editionId: string
  bookId: string
  title: string
  author: string
  kind: 'public' | 'private'
  ownerEmail: string | null
  indexStatus: string
  progress: number
  chunkCount: number | null
  error: string | null
  embedModel: string | null
  indexedAt: Date | null
  holders: number
}

export async function listEditions(): Promise<AdminEdition[]> {
  const rows = await db
    .select({
      editionId: editions.id,
      bookId: books.id,
      title: books.title,
      author: books.author,
      kind: editions.kind,
      ownerUserId: editions.ownerUserId,
      ownerEmail: users.email,
      indexStatus: editions.indexStatus,
      progress: editions.progress,
      chunkCount: editions.chunkCount,
      error: editions.error,
      embedModel: editions.embedModel,
      indexedAt: editions.indexedAt,
    })
    .from(editions)
    .innerJoin(books, eq(books.id, editions.bookId))
    .leftJoin(users, eq(users.id, editions.ownerUserId))
    .orderBy(desc(editions.createdAt))

  const holderAgg = await db
    .select({ editionId: userLibrary.editionId, holders: count(userLibrary.userId) })
    .from(userLibrary)
    .groupBy(userLibrary.editionId)
  const holders = new Map(holderAgg.map((r) => [r.editionId, Number(r.holders)]))

  return rows.map((r) => ({ ...r, holders: holders.get(r.editionId) ?? 0 }))
}

export type SystemStatus = {
  postgres: { ok: boolean; books: number; editions: number; chunks: number; users: number }
  qdrant: { ok: boolean; collection: string; points: number; error?: string }
  ollama: { ok: boolean; model: string; dim: number; error?: string }
  chatModel: string
  /** Rows and points must agree once indexing settles — see verify:index. */
  drift: number | null
  indexing: number
}

export async function systemStatus(): Promise<SystemStatus> {
  const [[b], [e], [c], [u]] = await Promise.all([
    db.select({ v: count() }).from(books),
    db.select({ v: count() }).from(editions),
    db.select({ v: count() }).from(chunks),
    db.select({ v: count() }).from(users),
  ])

  const inFlight = await db
    .select({ v: count() })
    .from(editions)
    .where(sql`${editions.indexStatus} in ('pending','parsing','embedding')`)

  let qd = { ok: false, collection: COLLECTION, points: 0, error: undefined as string | undefined }
  try {
    const info = await qdrant.getCollection(COLLECTION)
    qd = { ok: true, collection: COLLECTION, points: info.points_count ?? 0, error: undefined }
  } catch (err) {
    qd.error = err instanceof Error ? err.message : 'unreachable'
  }

  let ol = { ok: false, model: env.embed.model, dim: env.embed.dim, error: undefined as string | undefined }
  try {
    const res = await fetch(`${env.embed.url}/api/tags`, { signal: AbortSignal.timeout(4000) })
    ol.ok = res.ok
    if (!res.ok) ol.error = `HTTP ${res.status}`
  } catch (err) {
    ol.error = err instanceof Error ? err.message : 'unreachable'
  }

  const chunkTotal = Number(c.v)
  const settledIndexing = Number(inFlight[0]?.v ?? 0)

  return {
    postgres: {
      ok: true,
      books: Number(b.v),
      editions: Number(e.v),
      chunks: chunkTotal,
      users: Number(u.v),
    },
    qdrant: qd,
    ollama: ol,
    chatModel: env.chat.model,
    // Only meaningful when nothing is mid-embed; the panel says so.
    drift: settledIndexing === 0 && qd.ok ? chunkTotal - qd.points : null,
    indexing: settledIndexing,
  }
}

/* ------------------------------------------------------------------ *
 * Runtime settings
 * ------------------------------------------------------------------ */

export type SettingKey = 'allow_registration' | 'max_upload_mb'

const DEFAULTS: Record<SettingKey, string> = {
  allow_registration: 'true',
  max_upload_mb: '100',
}

export async function getSettings(): Promise<Record<SettingKey, string>> {
  const rows = await db.select().from(appSettings)
  const out = { ...DEFAULTS }
  for (const r of rows) {
    if (r.key in out) out[r.key as SettingKey] = r.value
  }
  return out
}

export async function setSetting(key: SettingKey, value: string): Promise<void> {
  await db
    .insert(appSettings)
    .values({ key, value, updatedAt: new Date() })
    .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: new Date() } })
}

/** Env-derived values the panel shows but must not pretend to edit. */
export function readOnlyConfig() {
  return [
    ['Embedding model', env.embed.model, 'Changing this invalidates every vector — re-embed required'],
    ['Embedding dimensions', String(env.embed.dim), 'Fixed by the model'],
    ['Qdrant collection', env.qdrant.collection, 'Named after the embedding model on purpose'],
    ['Embedding context', `${env.embed.maxTokens} tokens`, 'Chunking stays under this'],
    ['Chat model', env.chat.model, 'Swappable by env var; no data impact'],
    ['Qdrant URL', env.qdrant.url, ''],
    ['Ollama URL', env.embed.url, ''],
    ['Quote cap', `${MAX_QUOTE_CHARS} chars`, 'Legal posture — enforced server-side'],
    ['Reveal cap', `${Math.round(MAX_REVEAL_FRACTION * 100)}% per book`, 'Lifetime, per user per edition'],
  ] as const
}
