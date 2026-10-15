import { config } from 'dotenv'

config({ path: '.env.local', quiet: true })

async function main() {
  const { ensureCollection, qdrant, COLLECTION } = await import('@/lib/qdrant')
  const { env } = await import('@/lib/env')

  const result = await ensureCollection()
  const info = await qdrant.getCollection(COLLECTION)

  console.log(`collection "${COLLECTION}": ${result}`)
  console.log(`  model     ${env.embed.model} (${env.embed.dim}d, ${env.embed.maxTokens} tok ctx)`)
  console.log(`  points    ${info.points_count ?? 0}`)
  console.log(`  indexed   ${Object.keys(info.payload_schema ?? {}).join(', ') || 'none'}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
