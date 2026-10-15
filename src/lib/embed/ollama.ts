import { env } from '@/lib/env'

/**
 * bge-* models are ASYMMETRIC: queries get an instruction prefix, documents
 * get none. Prefixing both (or neither) measurably degrades retrieval, and
 * Ollama does not apply it for you — so it lives here, in the one place that
 * talks to the model, rather than at call sites where it can be forgotten.
 */
const QUERY_PREFIX = 'Represent this sentence for searching relevant passages: '

/**
 * Measured on the homelab against bge-large with realistic ~1200-char chunks
 * (64 chunks, fixed workload):
 *
 *   batch   8 -> 1518 ms/chunk
 *   batch  32 ->  666 ms/chunk
 *   batch  64 ->  527 ms/chunk   <- chosen
 *   batch 128 ->  539 ms/chunk
 *
 * Counter-intuitive only until you try it: per-request overhead dominates at
 * small batches. 128 stops helping, so there is no reason to hold more text
 * in flight.
 */
export const BATCH_SIZE = 64

export type EmbedKind = 'query' | 'passage'

type OllamaEmbedResponse = {
  embeddings: number[][]
  prompt_eval_count?: number
}

async function callOllama(input: string[]): Promise<number[][]> {
  const res = await fetch(`${env.embed.url}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: env.embed.model, input }),
  })

  if (!res.ok) {
    throw new Error(`Ollama embed failed (${res.status}): ${await res.text().catch(() => '')}`)
  }

  const data = (await res.json()) as OllamaEmbedResponse
  if (!data.embeddings?.length) throw new Error('Ollama returned no embeddings')

  const dim = data.embeddings[0].length
  if (dim !== env.embed.dim) {
    // Guards against EMBED_MODEL and QDRANT_COLLECTION drifting apart — the
    // one failure that is otherwise completely silent.
    throw new Error(
      `Embedding dim mismatch: model "${env.embed.model}" returned ${dim}, EMBED_DIM is ${env.embed.dim}`,
    )
  }

  return data.embeddings
}

/** Cosine distance assumes unit vectors. bge via Ollama already returns them;
 *  this is insurance for the day the model changes. */
function normalize(v: number[]): number[] {
  let sum = 0
  for (const x of v) sum += x * x
  const norm = Math.sqrt(sum)
  if (norm === 0 || Math.abs(norm - 1) < 1e-6) return v
  return v.map((x) => x / norm)
}

/**
 * Embed one or more texts.
 *
 * `kind` is not optional by design — getting the query/passage asymmetry
 * wrong is silent, so every caller must state which side it is on.
 */
export async function embed(texts: string[], kind: EmbedKind): Promise<number[][]> {
  if (!texts.length) return []

  const prepared = kind === 'query' ? texts.map((t) => QUERY_PREFIX + t) : texts

  const out: number[][] = []
  for (let i = 0; i < prepared.length; i += BATCH_SIZE) {
    const batch = prepared.slice(i, i + BATCH_SIZE)
    const vectors = await callOllama(batch)
    for (const v of vectors) out.push(normalize(v))
  }
  return out
}

export async function embedOne(text: string, kind: EmbedKind): Promise<number[]> {
  const [v] = await embed([text], kind)
  return v
}
