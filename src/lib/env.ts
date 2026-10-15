/**
 * Fail at boot, not on the first chat turn.
 *
 * The embed model/dim/collection triple is validated together on purpose:
 * a mismatch between EMBED_MODEL and QDRANT_COLLECTION produces plausible
 * scores over meaningless vectors, with no error anywhere. That is the one
 * failure mode in this system that is invisible at runtime.
 */

function required(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`Missing required env var: ${name}`)
  return v
}

function int(name: string, fallback: number): number {
  const v = process.env[name]
  if (!v) return fallback
  const n = Number(v)
  if (!Number.isInteger(n)) throw new Error(`${name} must be an integer, got "${v}"`)
  return n
}

export const env = {
  databaseUrl: required('DATABASE_URL'),

  qdrant: {
    url: required('QDRANT_URL'),
    apiKey: process.env.QDRANT_API_KEY || undefined,
    collection: required('QDRANT_COLLECTION'),
  },

  embed: {
    url: required('OLLAMA_URL'),
    model: required('EMBED_MODEL'),
    dim: int('EMBED_DIM', 1024),
    maxTokens: int('EMBED_MAX_TOKENS', 512),
  },

  chat: {
    model: process.env.CHAT_MODEL ?? 'openrouter:anthropic/claude-sonnet-4.5',
    fallback: process.env.CHAT_MODEL_FALLBACK || undefined,
    openrouterKey: process.env.OPENROUTER_API_KEY || undefined,
  },

  uploadDir: process.env.UPLOAD_DIR ?? './.data/uploads',
} as const
