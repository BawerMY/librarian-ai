import { QdrantClient } from '@qdrant/js-client-rest'

import { env } from '@/lib/env'

const globalForQdrant = globalThis as unknown as { __qdrant?: QdrantClient }

export const qdrant =
  globalForQdrant.__qdrant ??
  new QdrantClient({ url: env.qdrant.url, apiKey: env.qdrant.apiKey })

if (process.env.NODE_ENV !== 'production') globalForQdrant.__qdrant = qdrant

export const COLLECTION = env.qdrant.collection

/**
 * Chunk-level facts only. Everything per-book or per-edition (title, author,
 * translator) is joined from Postgres once per query instead of being stamped
 * onto every one of a book's ~2000 chunks.
 */
export type ChunkPayload = {
  /** Scope + authz key. The only field filtered in user search. */
  edition_id: string
  book_id: string
  chunk_idx: number
  visibility: 'public' | 'private'
  /** null for public editions; the single owner for private ones. */
  owner_id: string | null
  lang: string
  chapter: string | null
  section: string | null
  /** Real page, or null for EPUB/txt — then pos_pct is the locator. */
  page: number | null
  pos_pct: number
  text: string
}

/**
 * Deterministic point id: uuid5(namespace, "<edition>:<idx>").
 *
 * Makes upserts idempotent and backfills resumable — re-running an
 * interrupted index job overwrites rather than duplicating.
 */
const NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'

export async function pointId(editionId: string, idx: number): Promise<string> {
  const { v5 } = await import('uuid')
  return v5(`${editionId}:${idx}`, NAMESPACE)
}

export async function ensureCollection(): Promise<'created' | 'exists'> {
  const existing = await qdrant.getCollections()
  if (existing.collections.some((c) => c.name === COLLECTION)) return 'exists'

  await qdrant.createCollection(COLLECTION, {
    vectors: { size: env.embed.dim, distance: 'Cosine' },
    // Chunk text dominates payload size; keep it off the heap.
    on_disk_payload: true,
    // int8 quantized vectors resident, full precision on disk.
    // ~4x less RAM: 1M chunks goes from ~4GB to ~1GB.
    quantization_config: {
      scalar: { type: 'int8', always_ram: true },
    },
  })

  // Index ONLY what appears in a filter. Every other payload field is
  // read-only, and an index on it is RAM you never get back.
  await qdrant.createPayloadIndex(COLLECTION, {
    field_name: 'edition_id',
    field_schema: 'keyword',
  })
  await qdrant.createPayloadIndex(COLLECTION, {
    field_name: 'owner_id',
    field_schema: 'keyword',
  })
  await qdrant.createPayloadIndex(COLLECTION, {
    field_name: 'visibility',
    field_schema: 'keyword',
  })

  return 'created'
}
