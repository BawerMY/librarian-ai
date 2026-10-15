/**
 * Measure real token counts instead of trusting the chars/token estimate.
 *
 *   pnpm tsx scripts/calibrate-tokens.ts book.epub [--sample 60]
 *
 * Ollama returns `prompt_eval_count` on /api/embed, which for a single input
 * is that input's token count under the model's own tokenizer. bge-large's
 * window is 512 tokens and Ollama truncates past it SILENTLY — a chunk over
 * the limit is embedded from its first 512 tokens with no error anywhere, so
 * the only way to know the chunker is safe is to measure.
 */
import { readFile } from 'node:fs/promises'
import { config } from 'dotenv'

config({ path: '.env.local', quiet: true })

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}

async function tokenCount(url: string, model: string, text: string): Promise<number> {
  const res = await fetch(`${url}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input: [text] }),
  })
  if (!res.ok) throw new Error(`embed failed ${res.status}: ${await res.text()}`)
  const data = (await res.json()) as { prompt_eval_count?: number }
  if (typeof data.prompt_eval_count !== 'number') {
    throw new Error('Ollama did not return prompt_eval_count')
  }
  return data.prompt_eval_count
}

async function main() {
  const path = process.argv[2]
  if (!path) {
    console.error('usage: tsx scripts/calibrate-tokens.ts <file.epub> [--sample N]')
    process.exit(1)
  }

  const { parseEpub } = await import('@/lib/ingest/epub')
  const { chunkBook, CHARS_PER_TOKEN, estimateTokens } = await import('@/lib/ingest/chunk')
  const { env } = await import('@/lib/env')

  const book = await parseEpub(await readFile(path))
  const chunks = chunkBook(book)

  const chars = chunks.reduce((a, c) => a + c.text.length, 0)
  console.log(`chunks        ${chunks.length}`)
  console.log(`mean chars    ${Math.round(chars / chunks.length)}`)
  console.log(`max chars     ${Math.max(...chunks.map((c) => c.text.length))}`)
  console.log(`est. tokens   mean ${Math.round(chunks.reduce((a, c) => a + c.tokenCount, 0) / chunks.length)}, max ${Math.max(...chunks.map((c) => c.tokenCount))}`)

  // Sample widely rather than taking a prefix: front matter is not
  // representative of a book's prose.
  const n = Math.min(Number(arg('sample') ?? 60), chunks.length)
  const step = Math.max(1, Math.floor(chunks.length / n))
  const sample = chunks.filter((_, i) => i % step === 0).slice(0, n)

  console.log(`\nmeasuring ${sample.length} chunks against ${env.embed.model}…`)

  const ratios: number[] = []
  const actuals: number[] = []
  let over = 0

  for (const c of sample) {
    const tokens = await tokenCount(env.embed.url, env.embed.model, c.text)
    actuals.push(tokens)
    ratios.push(c.text.length / tokens)
    if (tokens >= env.embed.maxTokens) over++
  }

  ratios.sort((a, b) => a - b)
  actuals.sort((a, b) => a - b)
  const pct = (arr: number[], p: number) => arr[Math.min(arr.length - 1, Math.floor(arr.length * p))]

  console.log(`\nactual tokens   min ${actuals[0]}  p50 ${pct(actuals, 0.5)}  p95 ${pct(actuals, 0.95)}  max ${actuals[actuals.length - 1]}`)
  console.log(`chars/token     min ${ratios[0].toFixed(2)}  p50 ${pct(ratios, 0.5).toFixed(2)}  p95 ${pct(ratios, 0.95).toFixed(2)}  max ${ratios[ratios.length - 1].toFixed(2)}`)
  console.log(`configured      CHARS_PER_TOKEN = ${CHARS_PER_TOKEN}`)
  console.log(`window          ${env.embed.maxTokens} tokens`)

  if (over > 0) {
    console.log(`\n!! ${over}/${sample.length} sampled chunks hit the window — they are being TRUNCATED.`)
    console.log(`   Lower targetTokens, or lower CHARS_PER_TOKEN to ${(ratios[0] * 0.95).toFixed(2)}.`)
    process.exitCode = 1
  } else {
    const headroom = env.embed.maxTokens - actuals[actuals.length - 1]
    console.log(`\nOK — no truncation. Worst-case headroom: ${headroom} tokens.`)
    // The estimate must not run ahead of the tokenizer's worst case.
    if (ratios[0] < CHARS_PER_TOKEN) {
      console.log(
        `note: observed min chars/token (${ratios[0].toFixed(2)}) is below CHARS_PER_TOKEN ` +
          `(${CHARS_PER_TOKEN}), so estimateTokens() under-counts the densest text. ` +
          `Safe while headroom holds, but that is what the ceiling is for.`,
      )
    }
  }

  const worst = sample[actuals.indexOf(actuals[actuals.length - 1])]
  if (worst) {
    console.log(`\nlongest sampled chunk (${worst.text.length} chars)`)
    console.log(`  ${worst.chapter ?? '—'} / ${worst.section ?? '—'}`)
    console.log(`  ${worst.text.slice(0, 180)}…`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
